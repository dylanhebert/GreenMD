using System.IO;

namespace GreenMD.Host;

/// <summary>One node in a workspace's file tree. Flat, with a parent reference.</summary>
public sealed record TreeEntry(string Path, string Name, string Parent, bool IsDirectory);

public sealed record WorkspaceTree(
    string Root,
    string Name,
    IReadOnlyList<TreeEntry> Entries,
    bool Truncated);

/// <summary>
/// Workspaces are folders, and there can be several open at once. Each gets its own
/// recursive watcher so files appearing later show up on their own; the entry cap is
/// shared across all of them, because the thing worth bounding is the total the UI has
/// to render, not the depth of any single folder.
/// </summary>
public sealed class WorkspaceService : IDisposable
{
    private const int MaxEntriesTotal = 5000;
    private const int RescanDebounceMs = 400;

    private static readonly string[] Ignored =
        [".git", "node_modules", "bin", "obj", ".vs", "dist", ".idea", "packages"];

    private static readonly string[] MarkdownExtensions =
        [".md", ".markdown", ".mdown", ".mkd", ".mdtext"];

    private sealed class Root
    {
        public required FileSystemWatcher Watcher { get; init; }
    }

    private readonly Dictionary<string, Root> _roots = new(StringComparer.OrdinalIgnoreCase);
    private readonly Lock _gate = new();
    private Timer? _rescan;

    /// <summary>Raised on a background thread when files or folders appear or vanish.</summary>
    public event Action? TreeChanged;

    public IReadOnlyList<string> Roots
    {
        get { lock (_gate) return _roots.Keys.ToArray(); }
    }

    public bool Add(string root)
    {
        string full;
        try { full = Path.GetFullPath(root); }
        catch (ArgumentException) { return false; }
        catch (NotSupportedException) { return false; }
        catch (PathTooLongException) { return false; }

        if (!Directory.Exists(full)) return false;

        lock (_gate)
        {
            if (_roots.ContainsKey(full)) return false;

            // Adding a folder already covered by an open one would list everything twice.
            foreach (var existing in _roots.Keys)
            {
                if (IsUnder(full, existing) || IsUnder(existing, full)) return false;
            }

            var watcher = new FileSystemWatcher(full)
            {
                // Content changes are handled per open document by FileWatchService.
                // This one only cares about the shape of the tree.
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName,
                IncludeSubdirectories = true,
                InternalBufferSize = 64 * 1024
            };

            watcher.Created += (_, _) => ScheduleRescan();
            watcher.Deleted += (_, _) => ScheduleRescan();
            watcher.Renamed += (_, _) => ScheduleRescan();
            watcher.Error += (_, _) => ScheduleRescan();
            watcher.EnableRaisingEvents = true;

            _roots[full] = new Root { Watcher = watcher };
            return true;
        }
    }

    public void Remove(string root)
    {
        lock (_gate)
        {
            if (!_roots.Remove(Normalize(root), out var entry)) return;
            entry.Watcher.EnableRaisingEvents = false;
            entry.Watcher.Dispose();
        }
    }

    public void Clear()
    {
        lock (_gate)
        {
            foreach (var entry in _roots.Values)
            {
                entry.Watcher.EnableRaisingEvents = false;
                entry.Watcher.Dispose();
            }
            _roots.Clear();
        }
    }

    /// <summary>
    /// Walks every open folder. Enumeration only — file contents are never read, which
    /// matters on OneDrive where reading a placeholder triggers a download.
    /// </summary>
    public IReadOnlyList<WorkspaceTree> ScanAll()
    {
        var roots = Roots;
        var trees = new List<WorkspaceTree>(roots.Count);
        var budget = MaxEntriesTotal;

        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;

            var entries = new List<TreeEntry>();
            var truncated = Walk(root, root, entries, ref budget);

            entries.Sort(CompareEntries);
            trees.Add(new WorkspaceTree(root, new DirectoryInfo(root).Name, entries, truncated));
        }

        // Stable, predictable order in the sidebar.
        trees.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        return trees;
    }

    private static int CompareEntries(TreeEntry a, TreeEntry b)
    {
        if (a.Parent != b.Parent) return string.Compare(a.Parent, b.Parent, StringComparison.OrdinalIgnoreCase);
        if (a.IsDirectory != b.IsDirectory) return a.IsDirectory ? -1 : 1;
        return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Returns true if the scan hit the shared entry cap.</summary>
    private static bool Walk(string directory, string parent, List<TreeEntry> entries, ref int budget)
    {
        if (budget <= 0) return true;

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
            budget--;

            truncated |= Walk(subdirectory, subdirectory, entries, ref budget);

            // Prune folders that turned out to hold no markdown at all -- otherwise the
            // tree is mostly empty scaffolding.
            if (!entries.Skip(before + 1).Any(e => !e.IsDirectory))
            {
                budget += entries.Count - before;
                entries.RemoveRange(before, entries.Count - before);
            }
        }

        foreach (var file in files)
        {
            if (!MarkdownExtensions.Contains(Path.GetExtension(file), StringComparer.OrdinalIgnoreCase)) continue;
            if (budget <= 0) return true;

            entries.Add(new TreeEntry(file, Path.GetFileName(file), parent, false));
            budget--;
        }

        return truncated;
    }

    private static string Normalize(string path)
    {
        try { return Path.GetFullPath(path); }
        catch (ArgumentException) { return path; }
        catch (NotSupportedException) { return path; }
        catch (PathTooLongException) { return path; }
    }

    private static bool IsUnder(string candidate, string root)
    {
        var trimmed = root.TrimEnd(Path.DirectorySeparatorChar);
        if (!candidate.StartsWith(trimmed, StringComparison.OrdinalIgnoreCase)) return false;
        if (candidate.Length == trimmed.Length) return true;

        return candidate[trimmed.Length] == Path.DirectorySeparatorChar
               || candidate[trimmed.Length] == Path.AltDirectorySeparatorChar;
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

    public void Dispose()
    {
        Clear();

        lock (_gate)
        {
            _rescan?.Dispose();
            _rescan = null;
        }
    }
}
