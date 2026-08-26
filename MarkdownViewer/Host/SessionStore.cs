using System.IO;
using System.Text.Json;

namespace MarkdownViewer.Host;

/// <summary>
/// Persists the window's state between runs: which folder is open, which files are in
/// which panes, how the panes are arranged, and each pane's text size.
///
/// The shape is deliberately opaque to the host — `Layout` and `Zoom` are the only
/// things that understand it, so the host does not have to be updated every time the
/// UI grows a new bit of state.
/// </summary>
public sealed class SessionStore
{
    private const int SaveDebounceMs = 800;

    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly string _path;
    private readonly Lock _gate = new();
    private Timer? _pending;
    private JsonElement? _latest;

    public SessionStore()
    {
        var folder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "MarkdownViewer");
        Directory.CreateDirectory(folder);
        _path = Path.Combine(folder, "session.json");
    }

    public JsonElement? Load()
    {
        try
        {
            if (!File.Exists(_path)) return null;

            var json = File.ReadAllText(_path);
            if (string.IsNullOrWhiteSpace(json)) return null;

            using var document = JsonDocument.Parse(json);
            return document.RootElement.Clone();
        }
        catch (JsonException) { return null; }   // corrupt file: start fresh rather than fail to launch
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    /// <summary>
    /// Debounced — the UI reports state on every layout change, and a burst of tab
    /// operations should not mean a burst of disk writes.
    /// </summary>
    public void Save(JsonElement state)
    {
        lock (_gate)
        {
            _latest = state.Clone();

            if (_pending is not null)
            {
                _pending.Change(SaveDebounceMs, Timeout.Infinite);
                return;
            }

            _pending = new Timer(_ => Flush(), null, SaveDebounceMs, Timeout.Infinite);
        }
    }

    public void Flush()
    {
        JsonElement? state;

        lock (_gate)
        {
            _pending?.Dispose();
            _pending = null;
            state = _latest;
        }

        if (state is null) return;

        try
        {
            // Write to a temp file and move over the target, so a crash mid-write
            // cannot leave a truncated session that fails to parse next launch.
            var temporary = _path + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(state.Value, Options));
            File.Move(temporary, _path, overwrite: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
