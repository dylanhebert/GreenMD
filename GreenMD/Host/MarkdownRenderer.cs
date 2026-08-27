using System.IO;
using System.Text.RegularExpressions;
using Markdig;
using Markdig.Renderers;
using Markdig.Extensions.TaskLists;
using Markdig.Renderers.Html;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace GreenMD.Host;

public sealed record Heading(int Level, string Text, string Id);

/// <summary>
/// <paramref name="TaskOffsets"/> holds the source offset of each task-list marker, in
/// document order, so a checkbox clicked in the rendered view can be flipped in the
/// markdown itself. The offset points at the opening bracket of <c>[ ]</c>.
/// <paramref name="Assets"/> holds the absolute paths of the doc-local images the
/// rendered HTML references, so the host can watch them for live reload.
/// </summary>
public sealed record RenderedDoc(
    string Html, IReadOnlyList<Heading> Outline, IReadOnlyList<int> TaskOffsets, IReadOnlyList<string> Assets);

/// <summary>
/// Markdown to HTML, plus the heading outline. Both come from a single parse:
/// the outline is read off the AST rather than scraped from the DOM in JS.
/// </summary>
public static partial class MarkdownRenderer
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder()
        .UseAdvancedExtensions()   // GFM tables, task lists, footnotes, autolinks, auto heading ids
        .Build();

    /// <summary>Virtual origin for doc-local images, served by <see cref="AssetServer"/>.</summary>
    public const string AssetHost = "greenmd-asset.local";

    /// <summary>Virtual origin for links to other local files; the UI turns these into tabs.</summary>
    public const string OpenHost = "greenmd-open.local";

    public static RenderedDoc Render(string markdown, string? baseDirectory = null)
    {
        var document = Markdown.Parse(markdown, Pipeline);

        List<string> assets = string.IsNullOrEmpty(baseDirectory)
            ? []
            : RewriteLocalLinks(document, baseDirectory);

        var outline = document.Descendants<HeadingBlock>()
            .Select(h => new Heading(h.Level, InlineText(h.Inline), h.GetAttributes().Id ?? string.Empty))
            .Where(h => h.Id.Length > 0 && h.Text.Length > 0)
            .ToList();

        // Number the task-list markers in document order. The index is what the UI
        // sends back when a checkbox is clicked, and the offset is where to edit.
        var tasks = document.Descendants<TaskList>().ToList();
        var indexes = new Dictionary<TaskList, int>();
        for (var i = 0; i < tasks.Count; i++) indexes[tasks[i]] = i;

        using var writer = new StringWriter();
        var renderer = new HtmlRenderer(writer);
        Pipeline.Setup(renderer);

        // Markdig renders task checkboxes disabled. Swap in a live one so a doc full
        // of checkboxes is something you can actually tick off.
        renderer.ObjectRenderers.Replace<HtmlTaskListRenderer>(new InteractiveTaskListRenderer(indexes));

        renderer.Render(document);
        writer.Flush();

        return new RenderedDoc(
            Sanitize(writer.ToString()),
            outline,
            tasks.Select(task => task.Span.Start).ToList(),
            assets);
    }

    private sealed class InteractiveTaskListRenderer(Dictionary<TaskList, int> indexes)
        : HtmlObjectRenderer<TaskList>
    {
        protected override void Write(HtmlRenderer renderer, TaskList task)
        {
            renderer.Write("<input class=\"task\" type=\"checkbox\"");
            if (indexes.TryGetValue(task, out var index)) renderer.Write($" data-task=\"{index}\"");
            if (task.Checked) renderer.Write(" checked=\"checked\"");
            renderer.Write(" />");
        }
    }

    /// <summary>
    /// Flips one task marker in the source text. Returns null when the offset no longer
    /// looks like a checkbox, which means the document moved on since it was rendered.
    /// </summary>
    public static string? ToggleTask(string markdown, int offset, bool check)
    {
        if (offset < 0 || offset + 2 >= markdown.Length) return null;
        if (markdown[offset] != '[' || markdown[offset + 2] != ']') return null;

        return markdown.Remove(offset + 1, 1).Insert(offset + 1, check ? "x" : " ");
    }

    /// <summary>
    /// Points relative images and local file links at virtual origins the host serves,
    /// and returns the resolved image paths for the caller to watch.
    /// Rewriting on the AST rather than the emitted HTML means image and link syntax are
    /// handled by the same rule, and there is no regex chasing quoting in attributes.
    /// </summary>
    private static List<string> RewriteLocalLinks(MarkdownDocument document, string baseDirectory)
    {
        var assets = new List<string>();

        foreach (var link in document.Descendants<LinkInline>())
        {
            var url = link.Url;
            if (string.IsNullOrWhiteSpace(url)) continue;
            if (url.StartsWith('#')) continue;

            // Leave anything with a real scheme alone. Checking for "://" rather than
            // Uri.TryCreate avoids treating a Windows drive letter as a scheme.
            if (url.Contains("://") || url.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase)) continue;

            var target = url;
            var fragment = string.Empty;

            var hash = target.IndexOf('#');
            if (hash >= 0)
            {
                fragment = target[hash..];
                target = target[..hash];
            }

            if (target.Length == 0) continue;

            try
            {
                var resolved = Path.GetFullPath(Path.Combine(baseDirectory, Uri.UnescapeDataString(target)));
                var host = link.IsImage ? AssetHost : OpenHost;
                link.Url = $"https://{host}/{Uri.EscapeDataString(resolved)}{fragment}";
                if (link.IsImage) assets.Add(resolved);
            }
            catch (ArgumentException) { /* not a usable path; leave the link as authored */ }
            catch (NotSupportedException) { }
            catch (PathTooLongException) { }
        }

        return assets;
    }

    private static string InlineText(ContainerInline? container)
    {
        if (container is null) return string.Empty;
        return string.Concat(container.Descendants().Select(i => i switch
        {
            LiteralInline literal => literal.Content.ToString(),
            CodeInline code => code.Content,
            _ => string.Empty
        })).Trim();
    }

    /// <summary>
    /// Markdown may contain raw HTML, and a doc pulled off the internet should not be able
    /// to reach the host bridge. The CSP in index.html blocks inline script execution; this
    /// strips the markup so it does not show up as stray text either.
    /// </summary>
    private static string Sanitize(string html)
    {
        html = ScriptOrStyle().Replace(html, string.Empty);
        html = EventHandlerAttribute().Replace(html, string.Empty);
        html = JavascriptUrl().Replace(html, "href=\"#\"");
        return html;
    }

    [GeneratedRegex(@"<(script|style|iframe|object|embed)\b[^>]*>.*?</\1\s*>|<(script|style|iframe|object|embed)\b[^>]*/?>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex ScriptOrStyle();

    [GeneratedRegex(@"\son[a-z]+\s*=\s*(""[^""]*""|'[^']*'|[^\s>]+)", RegexOptions.IgnoreCase)]
    private static partial Regex EventHandlerAttribute();

    [GeneratedRegex(@"href\s*=\s*(""|')\s*javascript:[^""']*\1", RegexOptions.IgnoreCase)]
    private static partial Regex JavascriptUrl();
}
