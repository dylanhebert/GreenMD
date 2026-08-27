using System.IO;

namespace MarkdownViewer.Host;

/// <summary>
/// Watches open documents for external changes.
///
/// Watches the containing *directory*, never the file path. Most write tooling —
/// including agent tooling — writes a temp file and renames over the target, which
/// fires Deleted + Created rather than Changed and invalidates a file-level handle.
///
/// Every event is debounced before anything reads the file, which also collapses the
/// two or three duplicate events a single save produces, and gives a delete-then-create
/// rename time to land before it looks like a deletion.
/// </summary>
public sealed class FileWatchService : IDisposable
{
    private const int DebounceMs = 200;
    private const int PollMs = 3000;

    private sealed class DirectoryWatch
    {
        public required FileSystemWatcher Watcher { get; init; }
        public HashSet<string> Files { get; } = new(StringComparer.OrdinalIgnoreCase);
    }

    private readonly Dictionary<string, DirectoryWatch> _watches = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, Timer> _pending = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, (DateTime Written, long Length)> _stamps = new(StringComparer.OrdinalIgnoreCase);
    private readonly Lock _gate = new();
    private readonly Timer _poll;
    private bool _disposed;

    /// <summary>Raised on a background thread once a path has been quiet for the debounce window.</summary>
    public event Action<string>? Changed;

    public FileWatchService()
    {
        // Backstop. FileSystemWatcher can silently miss events on network shares and
        // sync-backed folders, so open documents also get a cheap metadata poll.
        _poll = new Timer(_ => PollOpenFiles(), null, PollMs, PollMs);
    }

    public void Watch(string filePath)
    {
        var full = Path.GetFullPath(filePath);
        var directory = Path.GetDirectoryName(full);
        if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory)) return;

        lock (_gate)
        {
            if (!_watches.TryGetValue(directory, out var watch))
            {
                var watcher = new FileSystemWatcher(directory)
                {
                    // Attributes is deliberately excluded. OneDrive hydration and
                    // dehydration are attribute changes, and including it means
                    // re-rendering on every housekeeping pass.
                    NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size,
                    IncludeSubdirectories = false,
                    InternalBufferSize = 64 * 1024
                };

                watch = new DirectoryWatch { Watcher = watcher };

                watcher.Changed += (_, e) => Touch(e.FullPath);
                watcher.Created += (_, e) => Touch(e.FullPath);
                watcher.Deleted += (_, e) => Touch(e.FullPath);
                watcher.Renamed += (_, e) => { Touch(e.OldFullPath); Touch(e.FullPath); };
                watcher.Error += (_, _) => RescanDirectory(directory);

                watcher.EnableRaisingEvents = true;
                _watches[directory] = watch;
            }

            watch.Files.Add(full);
            _stamps[full] = StampOf(full);
        }
    }

    public void Unwatch(string filePath)
    {
        var full = Path.GetFullPath(filePath);
        var directory = Path.GetDirectoryName(full);
        if (string.IsNullOrEmpty(directory)) return;

        lock (_gate)
        {
            _stamps.Remove(full);

            if (_pending.Remove(full, out var timer)) timer.Dispose();

            if (!_watches.TryGetValue(directory, out var watch)) return;

            watch.Files.Remove(full);
            if (watch.Files.Count > 0) return;

            watch.Watcher.EnableRaisingEvents = false;
            watch.Watcher.Dispose();
            _watches.Remove(directory);
        }
    }

    private void Touch(string fullPath)
    {
        lock (_gate)
        {
            if (_disposed) return;

            var directory = Path.GetDirectoryName(fullPath);
            if (directory is null
                || !_watches.TryGetValue(directory, out var watch)
                || !watch.Files.Contains(fullPath))
            {
                return;
            }

            if (_pending.TryGetValue(fullPath, out var existing))
            {
                // Still settling — push the window out rather than firing mid-write.
                existing.Change(DebounceMs, Timeout.Infinite);
                return;
            }

            _pending[fullPath] = new Timer(_ => Fire(fullPath), null, DebounceMs, Timeout.Infinite);
        }
    }

    private void Fire(string fullPath)
    {
        lock (_gate)
        {
            if (_pending.Remove(fullPath, out var timer)) timer.Dispose();
            if (_disposed) return;
            _stamps[fullPath] = StampOf(fullPath);
        }

        Changed?.Invoke(fullPath);
    }

    /// <summary>
    /// The Error event means the watcher is no longer reliable — a dropped buffer, or the
    /// directory handle going away underneath it, which happens on sync-backed folders.
    /// Re-touching the files is not enough: if the watcher itself is dead it will never
    /// report anything again. Rebuild it, then recheck everything it was covering.
    /// </summary>
    private void RescanDirectory(string directory)
    {
        string[] files;

        lock (_gate)
        {
            if (_disposed || !_watches.TryGetValue(directory, out var watch)) return;

            files = watch.Files.ToArray();

            watch.Watcher.EnableRaisingEvents = false;
            watch.Watcher.Dispose();
            _watches.Remove(directory);
        }

        // Watch() recreates the directory watcher on first use.
        foreach (var file in files) Watch(file);
        foreach (var file in files) Touch(file);
    }

    /// <summary>
    /// Verifies each watcher is still live and rebuilds any that are not. FileSystemWatcher
    /// can stop delivering events without raising Error at all, which is the failure mode
    /// behind "I edited the file and nothing happened" after an app has been open for hours.
    /// </summary>
    private void ReviveDeadWatchers()
    {
        List<string> broken = [];

        lock (_gate)
        {
            if (_disposed) return;

            foreach (var (directory, watch) in _watches)
            {
                if (!Directory.Exists(directory)) continue;
                if (!watch.Watcher.EnableRaisingEvents) broken.Add(directory);
            }
        }

        foreach (var directory in broken) RescanDirectory(directory);
    }

    private void PollOpenFiles()
    {
        ReviveDeadWatchers();

        List<string> stale = [];

        lock (_gate)
        {
            if (_disposed) return;

            foreach (var (path, previous) in _stamps)
            {
                var current = StampOf(path);
                if (current == previous) continue;

                _stamps[path] = current;
                stale.Add(path);
            }
        }

        foreach (var path in stale) Changed?.Invoke(path);
    }

    private static (DateTime Written, long Length) StampOf(string path)
    {
        try
        {
            var info = new FileInfo(path);
            return info.Exists ? (info.LastWriteTimeUtc, info.Length) : (DateTime.MinValue, -1);
        }
        catch (IOException) { return (DateTime.MinValue, -2); }
        catch (UnauthorizedAccessException) { return (DateTime.MinValue, -2); }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;

            foreach (var timer in _pending.Values) timer.Dispose();
            _pending.Clear();

            foreach (var watch in _watches.Values)
            {
                watch.Watcher.EnableRaisingEvents = false;
                watch.Watcher.Dispose();
            }
            _watches.Clear();
            _stamps.Clear();
        }

        _poll.Dispose();
    }
}
