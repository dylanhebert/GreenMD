using System.IO;
using Microsoft.Web.WebView2.Core;

namespace MarkdownViewer.Host;

/// <summary>
/// Serves doc-local images over the <c>mdasset.local</c> virtual origin.
///
/// One interception point rather than a <c>SetVirtualHostNameToFolderMapping</c> per
/// open folder: mappings are global to the WebView2 and would accumulate as tabs come
/// and go, and there would be no single place to enforce the root allowlist.
/// </summary>
public sealed class AssetServer
{
    private readonly HashSet<string> _roots = new(StringComparer.OrdinalIgnoreCase);
    private readonly Lock _gate = new();

    private static readonly Dictionary<string, string> MimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".webp"] = "image/webp",
        [".bmp"] = "image/bmp",
        [".svg"] = "image/svg+xml",
        [".ico"] = "image/x-icon",
        [".avif"] = "image/avif"
    };

    /// <summary>Allows reads under a document's own folder. Called as documents open.</summary>
    public void AllowRoot(string directory)
    {
        if (string.IsNullOrEmpty(directory)) return;
        lock (_gate) _roots.Add(Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar));
    }

    public void Attach(CoreWebView2 core)
    {
        core.AddWebResourceRequestedFilter(
            $"https://{MarkdownRenderer.AssetHost}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, e) => Serve(core, e);
    }

    private void Serve(CoreWebView2 core, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var path = DecodePath(e.Request.Uri);

        if (path is null || !IsAllowed(path) || !File.Exists(path))
        {
            e.Response = core.Environment.CreateWebResourceResponse(null, 404, "Not Found", string.Empty);
            return;
        }

        try
        {
            var extension = Path.GetExtension(path);
            if (!MimeTypes.TryGetValue(extension, out var mime))
            {
                // Only images are served. Anything else would make this a general
                // file-read primitive for whatever HTML a document happens to contain.
                e.Response = core.Environment.CreateWebResourceResponse(null, 415, "Unsupported", string.Empty);
                return;
            }

            var stream = new MemoryStream(File.ReadAllBytes(path));
            e.Response = core.Environment.CreateWebResourceResponse(
                stream, 200, "OK", $"Content-Type: {mime}\r\nCache-Control: no-cache");
        }
        catch (IOException)
        {
            e.Response = core.Environment.CreateWebResourceResponse(null, 500, "Read Error", string.Empty);
        }
        catch (UnauthorizedAccessException)
        {
            e.Response = core.Environment.CreateWebResourceResponse(null, 403, "Forbidden", string.Empty);
        }
    }

    private static string? DecodePath(string uri)
    {
        try
        {
            var parsed = new Uri(uri);
            var encoded = parsed.AbsolutePath.TrimStart('/');
            if (encoded.Length == 0) return null;
            return Path.GetFullPath(Uri.UnescapeDataString(encoded));
        }
        catch (UriFormatException) { return null; }
        catch (ArgumentException) { return null; }
        catch (NotSupportedException) { return null; }
        catch (PathTooLongException) { return null; }
    }

    private bool IsAllowed(string path)
    {
        lock (_gate)
        {
            foreach (var root in _roots)
            {
                if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;

                // Guard against C:\docs matching C:\docs-other.
                if (path.Length == root.Length) return true;
                if (path[root.Length] == Path.DirectorySeparatorChar
                    || path[root.Length] == Path.AltDirectorySeparatorChar)
                {
                    return true;
                }
            }
        }

        return false;
    }
}
