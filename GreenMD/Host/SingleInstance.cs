using System.IO;
using System.IO.Pipes;
using System.Text;

namespace GreenMD.Host;

/// <summary>
/// Keeps one window per user session. Double-clicking a second .md file hands the path
/// to the running instance instead of starting a second process, which is the whole
/// point of having tabs.
/// </summary>
public sealed class SingleInstance : IDisposable
{
    private static readonly string Key = $"GreenMD.{Environment.UserName}";
    private static readonly string PipeName = $"{Key}.open";

    private readonly Mutex _mutex;
    private CancellationTokenSource? _cancellation;

    public bool IsFirstInstance { get; }

    /// <summary>Raised on a background thread when another launch hands over a path.</summary>
    public event Action<string>? FileRequested;

    public SingleInstance()
    {
        // Local\ scopes the mutex to the session, so a second user on the same machine
        // gets their own window rather than being told one is already running.
        _mutex = new Mutex(initiallyOwned: true, $"Local\\{Key}", out var createdNew);
        IsFirstInstance = createdNew;
    }

    /// <summary>Sends a path to the running instance. False if nothing is listening.</summary>
    public static bool TryHandOff(string path)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(2000);

            var bytes = Encoding.UTF8.GetBytes(path);
            client.Write(bytes, 0, bytes.Length);
            client.Flush();
            return true;
        }
        catch (TimeoutException) { return false; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    public void StartListening()
    {
        if (!IsFirstInstance) return;

        _cancellation = new CancellationTokenSource();
        _ = Task.Run(() => ListenAsync(_cancellation.Token));
    }

    private async Task ListenAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                using var server = new NamedPipeServerStream(
                    PipeName, PipeDirection.In, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous);

                await server.WaitForConnectionAsync(token).ConfigureAwait(false);

                using var reader = new StreamReader(server, Encoding.UTF8);
                var path = (await reader.ReadToEndAsync(token).ConfigureAwait(false)).Trim();

                if (path.Length > 0) FileRequested?.Invoke(path);
            }
            catch (OperationCanceledException) { return; }
            catch (IOException)
            {
                // Broken pipe on a half-open connection; just wait for the next one.
            }
        }
    }

    public void Dispose()
    {
        _cancellation?.Cancel();
        _cancellation?.Dispose();

        if (IsFirstInstance)
        {
            try { _mutex.ReleaseMutex(); } catch (ApplicationException) { }
        }

        _mutex.Dispose();
    }
}
