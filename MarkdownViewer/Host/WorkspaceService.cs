using System.IO;

namespace MarkdownViewer.Host;

/// <summary>One node in a workspace's file tree. Flat, with a parent reference.</summary>
public sealed record TreeEntry(string Path, string Name, string Parent, bool IsDirectory);

public sealed record WorkspaceTree(
    string Root,
    string Name,
    IReadOnlyList<TreeEntry> Entries,
    bool Truncated);

/// <summary>
/// A workspace is a folder. Bind one and the markdown files inside it are listed,
/// including files that appear later — the folder is already being watched, so
/// discovery costs nothing extra.
/// </summary>
public sealed class WorkspaceService : IDisposable
{
    private const int MaxEntries = 5000;
    private const int RescanDebounceMs = 400;

    private static readonly string[] Ignored =
        [".git", "node_modules", "bin", "obj", ".vs", "dist", ".idea", "packages"];

    private static readonly string[] MarkdownExtensions =
        [".md", ".markdown", ".mdown", ".mkd", ".mdtext"];

    private FileSystemWatcher? _watcher;
    private Timer? _rescan;
    private readonly Lock _gate = new();

    public string? Root { get; private set; }

    /// <summary>Raised on a background thread when files or folders appear or vanish.</summary>
    public event Action? TreeChanged;

    public void Open(string root)
    {
        var full = Path.GetFullPath(root);
        if (!Directory.Exists(full)) return;

        lock (_gate)
        {
            DisposeWatcher();
            Root = full;

            // One recursive watcher for the whole tree rather than one per directory.
            // It also picks up folders created after the workspace was opened.
            _watcher = new FileSystemWatcher(full)
            {
                // Content changes are handled per open document by FileWatchService.
                // This one only cares about the shape of the tree.
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName,
                IncludeSubdirectories = true,
                InternalBufferSize = 64 * 1024
            };

            _watcher.Created += (_, _) => ScheduleRescan();
            _watcher.Deleted += (_, _) => ScheduleRescan();
            _watcher.Renamed += (_, _) => ScheduleRescan();
            _watcher.Error += (_, _) => ScheduleRescan();

            _watcher.EnableRaisingEvents = true;
        }
    }

    public void Close()
    {
        lock (_gate)
        {
            DisposeWatcher();
            Root = null;
        }
    }

    /// <summary>
    /// Walks the tree. Enumeration only — file contents are never read, which matters
    /// on OneDrive where reading a placeholder triggers a download.
    /// </summary>
    public WorkspaceTree? Scan()
    {
        var root = Root;
        if (root is null || !Directory.Exists(root)) return null;

        var entries = new List<TreeEntry>();
        var truncated = Walk(root, root, entries);

        entries.Sort((a, b) =>
        {
            if (a.Parent != b.Parent) return string.Compare(a.Parent, b.Parent, StringComparison.OrdinalIgnoreCase);
            if (a.IsDirectory != b.IsDirectory) return a.IsDirectory ? -1 : 1;
            return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
        });

        return new WorkspaceTree(root, new DirectoryInfo(root).Name, entries, truncated);
    }

    /// <summary>Returns true if the scan hit the entry cap.</summary>
    private static bool Walk(string directory, string parent, List<TreeEntry> entries)
    {
        if (entries.Count >= MaxEntries) return true;

        string[] subdirectories;
        string[] files;

        try
        {
            subdirectories = Directory.GetDirectories(directory);
            files = Directory.GetFiles(directory);
        }
        catch (UnauthorizedAccessException) { return false; }
        catch (IOException) { return false; }

        var truncated = false;

        foreach (var subdirectory in subdirectories)
        {
            var name = Path.GetFileName(subdirectory);
            if (Ignored.Contains(name, StringComparer.OrdinalIgnoreCase)) continue;
            if (name.StartsWith('.')) continue;

            var before = entries.Count;
            entries.Add(new TreeEntry(subdirectory, name, parent, true));

            truncated |= Walk(subdirectory, subdirectory, entries);

            // Prune folders that turned out to hold no markdown at all -- otherwise the
            // tree is mostly empty scaffolding.
            if (!entries.Skip(before + 1).Any(e => !e.IsDirectory))
            {
                entries.RemoveRange(before, entries.Count - before);
            }
        }

        foreach (var file in files)
        {
            if (!MarkdownExtensions.Contains(Path.GetExtension(file), StringComparer.OrdinalIgnoreCase)) continue;

            if (entries.Count >= MaxEntries) return true;
            entries.Add(new TreeEntry(file, Path.GetFileName(file), parent, false));
        }

        return truncated;
    }

    private void ScheduleRescan()
    {
        lock (_gate)
        {
            if (_rescan is not null)
            {
                _rescan.Change(RescanDebounceMs, Timeout.Infinite);
                return;
            }

            _rescan = new Timer(_ =>
            {
                lock (_gate)
                {
                    _rescan?.Dispose();
                    _rescan = null;
                }
                TreeChanged?.Invoke();
            }, null, RescanDebounceMs, Timeout.Infinite);
        }
    }

    private void DisposeWatcher()
    {
        if (_watcher is not null)
        {
            _watcher.EnableRaisingEvents = false;
            _watcher.Dispose();
            _watcher = null;
        }

        _rescan?.Dispose();
        _rescan = null;
    }

    public void Dispose()
    {
        lock (_gate) DisposeWatcher();
    }
}
