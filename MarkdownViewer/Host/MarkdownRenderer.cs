using System.IO;
using System.Text.RegularExpressions;
using Markdig;
using Markdig.Renderers;
using Markdig.Renderers.Html;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace MarkdownViewer.Host;

public sealed record Heading(int Level, string Text, string Id);

public sealed record RenderedDoc(string Html, IReadOnlyList<Heading> Outline);

/// <summary>
/// Markdown to HTML, plus the heading outline. Both come from a single parse:
/// the outline is read off the AST rather than scraped from the DOM in JS.
/// </summary>
public static partial class MarkdownRenderer
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder()
        .UseAdvancedExtensions()   // GFM tables, task lists, footnotes, autolinks, auto heading ids
        .Build();

    public static RenderedDoc Render(string markdown)
    {
        var document = Markdown.Parse(markdown, Pipeline);

        var outline = document.Descendants<HeadingBlock>()
            .Select(h => new Heading(h.Level, InlineText(h.Inline), h.GetAttributes().Id ?? string.Empty))
            .Where(h => h.Id.Length > 0 && h.Text.Length > 0)
            .ToList();

        using var writer = new StringWriter();
        var renderer = new HtmlRenderer(writer);
        Pipeline.Setup(renderer);
        renderer.Render(document);
        writer.Flush();

        return new RenderedDoc(Sanitize(writer.ToString()), outline);
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
