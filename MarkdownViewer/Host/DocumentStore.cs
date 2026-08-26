using System.Collections.Concurrent;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace MarkdownViewer.Host;

/// <summary>
/// One open markdown file. Keyed by absolute path, shared across every pane showing it,
/// so the same file open twice is one watcher and one render.
/// </summary>
public sealed class Document
{
    public required string Path { get; init; }
    public string Title => System.IO.Path.GetFileName(Path);

    /// <summary>Kept in memory even though v1 is read-only — the edit toggle needs it.</summary>
    public string RawText { get; set; } = string.Empty;

    public string Html { get; set; } = string.Empty;
    public IReadOnlyList<Heading> Outline { get; set; } = [];

    /// <summary>Hash of the file bytes. Watchers fire far more often than content changes.</summary>
    public string Hash { get; set; } = string.Empty;

    public bool Missing { get; set; }
    public DateTimeOffset LoadedAt { get; set; }
}

public sealed class DocumentStore
{
    // OneDrive Files On-Demand. A plain ReparsePoint is NOT enough to mean "cloud only" --
    // hydrated placeholders carry it too. These two are what actually block on the network.
    private const FileAttributes RecallOnDataAccess = (FileAttributes)0x00400000;
    private const FileAttributes RecallOnOpen = (FileAttributes)0x00040000;

    private readonly ConcurrentDictionary<string, Document> _documents =
        new(StringComparer.OrdinalIgnoreCase);

    public static string Normalize(string path) => Path.GetFullPath(path);

    public Document? Get(string path) =>
        _documents.TryGetValue(Normalize(path), out var document) ? document : null;

    public IReadOnlyCollection<string> OpenPaths => _documents.Keys.ToArray();

    public void Remove(string path) => _documents.TryRemove(Normalize(path), out _);

    /// <summary>True when opening the file would trigger a OneDrive download.</summary>
    public static bool IsCloudOnly(string path)
    {
        try
        {
            var attributes = File.GetAttributes(path);
            return attributes.HasFlag(FileAttributes.Offline)
                   || (attributes & RecallOnDataAccess) != 0
                   || (attributes & RecallOnOpen) != 0;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    public async Task<Document> LoadAsync(string path)
    {
        var full = Normalize(path);
        var document = _documents.GetOrAdd(full, key => new Document { Path = key });
        await RefreshAsync(document).ConfigureAwait(false);
        return document;
    }

    /// <summary>
    /// Re-reads from disk. Returns false when nothing actually changed, which is the
    /// common case: a single save fires several watcher events, and OneDrive sync can
    /// rewrite a file with byte-identical content.
    /// </summary>
    public async Task<bool> ReloadAsync(string path)
    {
        var document = Get(path);
        if (document is null) return false;

        var before = document.Hash;
        var wasMissing = document.Missing;
        await RefreshAsync(document).ConfigureAwait(false);

        return document.Hash != before || document.Missing != wasMissing;
    }

    private static async Task RefreshAsync(Document document)
    {
        var bytes = await ReadWithRetryAsync(document.Path).ConfigureAwait(false);

        if (bytes is null)
        {
            document.Missing = true;
            document.Hash = string.Empty;
            document.Html = MissingHtml(document.Path);
            document.Outline = [];
            document.LoadedAt = DateTimeOffset.Now;
            return;
        }

        var hash = Convert.ToHexString(SHA256.HashData(bytes));
        document.Missing = false;
        document.LoadedAt = DateTimeOffset.Now;

        if (hash == document.Hash && document.Html.Length > 0) return;

        document.Hash = hash;
        document.RawText = Decode(bytes);

        var rendered = MarkdownRenderer.Render(document.RawText, Path.GetDirectoryName(document.Path));
        document.Html = rendered.Html;
        document.Outline = rendered.Outline;
    }

    /// <summary>
    /// Watchers fire while the writer still holds the file, so a first read often throws.
    /// Retries briefly rather than surfacing a transient failure as a missing file.
    /// </summary>
    private static async Task<byte[]?> ReadWithRetryAsync(string path)
    {
        for (var attempt = 0; attempt < 6; attempt++)
        {
            try
            {
                if (!File.Exists(path)) return null;

                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete, 8192, useAsync: true);

                using var buffer = new MemoryStream();
                await stream.CopyToAsync(buffer).ConfigureAwait(false);
                return buffer.ToArray();
            }
            catch (IOException)
            {
                await Task.Delay(60 * (attempt + 1)).ConfigureAwait(false);
            }
            catch (UnauthorizedAccessException)
            {
                await Task.Delay(60 * (attempt + 1)).ConfigureAwait(false);
            }
        }

        return null;
    }

    /// <summary>BOM if present, UTF-8 otherwise — which is what agent-written files are.</summary>
    private static string Decode(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes);
        using var reader = new StreamReader(stream, new UTF8Encoding(false),
            detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    private static string MissingHtml(string path)
    {
        var name = System.Net.WebUtility.HtmlEncode(Path.GetFileName(path));
        var folder = System.Net.WebUtility.HtmlEncode(Path.GetDirectoryName(path) ?? string.Empty);
        return $"""
            <div class="doc-missing">
              <h1>{name}</h1>
              <p>This file is no longer on disk.</p>
              <p class="doc-missing-path">{folder}</p>
            </div>
            """;
    }
}
