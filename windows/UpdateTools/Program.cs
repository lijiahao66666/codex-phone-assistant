using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CodexPhone;

internal static class UpdateToolsProgram
{
    private static async Task<int> Main(string[] args)
    {
        try {
            if (args.Length == 1 && args[0] == "self-test") {
                await RunSelfTestAsync();
                Console.WriteLine("Windows update self-test passed: signature, version gate, download and SHA-256 rejection.");
                return 0;
            }
            if (args.Length == 7 && args[0] == "sign" && args[1] == "--private-key" && args[3] == "--manifest" && args[5] == "--signature") {
                Sign(args[2], args[4], args[6]);
                Console.WriteLine($"Signed {args[4]}");
                return 0;
            }
            if (args.Length == 7 && args[0] == "verify" && args[1] == "--manifest" && args[3] == "--signature" && args[5] == "--public-key") {
                UpdateService.VerifyDetachedSignature(File.ReadAllBytes(args[2]), File.ReadAllBytes(args[4]), args[6]);
                Console.WriteLine($"Verified {args[2]}");
                return 0;
            }
            Console.Error.WriteLine("Usage: UpdateTools self-test | sign|verify --private-key|--manifest|--signature|--public-key <path>");
            return 2;
        } catch (Exception error) {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static void Sign(string privateKeyPath, string manifestPath, string signaturePath)
    {
        using var key = ECDsa.Create();
        key.ImportPkcs8PrivateKey(File.ReadAllBytes(privateKeyPath), out _);
        var signature = key.SignData(File.ReadAllBytes(manifestPath), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        File.WriteAllText(signaturePath, Convert.ToBase64String(signature), Encoding.ASCII);
    }

    private static async Task RunSelfTestAsync()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var publicKey = Convert.ToBase64String(key.ExportSubjectPublicKeyInfo());
        var installer = RandomNumberGenerator.GetBytes(256 * 1024);
        var manifest = JsonSerializer.SerializeToUtf8Bytes(new {
            schemaVersion = 1,
            channel = "stable",
            version = "0.3.50",
            build = 50,
            publishedAt = DateTimeOffset.UtcNow,
            installer = new {
                url = "",
                size = installer.Length,
                sha256 = Convert.ToHexString(SHA256.HashData(installer)).ToLowerInvariant(),
                signerThumbprint = (string?)null,
            },
            releaseNotesUrl = "https://codex.air-inc.top/download/windows/notes.html",
        });
        await using var server = new LocalHttpServer();
        manifest = ReplaceInstallerUrl(manifest, server.BaseUri + "setup.exe");
        var signature = key.SignData(manifest, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        server.Add("/latest.json", manifest, "application/json");
        server.Add("/latest.json.sig", Encoding.ASCII.GetBytes(Convert.ToBase64String(signature)), "text/plain");
        server.Add("/setup.exe", installer, "application/octet-stream");

        using var service = new UpdateService(new Uri(server.BaseUri + "latest.json"), 49, publicKey, true);
        var release = await service.CheckAsync() ?? throw new InvalidOperationException("New release was not detected");
        Require(release.Build == 50 && release.Version == "0.3.50", "Release metadata mismatch");
        using (var current = new UpdateService(new Uri(server.BaseUri + "latest.json"), 50, publicKey, true)) {
            Require(await current.CheckAsync() is null, "Current build should not update");
        }

        var manualManifest = JsonSerializer.SerializeToUtf8Bytes(new {
            schemaVersion = 2, channel = "stable", version = "0.3.51", build = 51, publishedAt = DateTimeOffset.UtcNow,
        });
        var manualSignature = key.SignData(manualManifest, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        server.Add("/manual.json", manualManifest, "application/json");
        server.Add("/manual.json.sig", Encoding.ASCII.GetBytes(Convert.ToBase64String(manualSignature)), "text/plain");
        using (var manual = new UpdateService(new Uri(server.BaseUri + "manual.json"), 50, publicKey, true)) {
            var manualRelease = await manual.CheckAsync();
            Require(manualRelease?.Build == 51 && manualRelease.Version == "0.3.51", "Signed version-only manifest was not accepted");
        }
        var tamperedManual = manualManifest.ToArray();
        tamperedManual[^2] ^= 1;
        server.Add("/manual-tampered.json", tamperedManual, "application/json");
        server.Add("/manual-tampered.json.sig", Encoding.ASCII.GetBytes(Convert.ToBase64String(manualSignature)), "text/plain");
        using (var manual = new UpdateService(new Uri(server.BaseUri + "manual-tampered.json"), 50, publicKey, true)) {
            try {
                await manual.CheckAsync();
                throw new InvalidOperationException("Tampered version-only manifest was accepted");
            } catch (UpdateException error) when (error.Message.Contains("签名", StringComparison.Ordinal)) { }
        }

        var output = Path.Combine(Path.GetTempPath(), "codex-update-test-" + Guid.NewGuid().ToString("N"));
        try {
            var downloaded = await service.DownloadAndVerifyAsync(release, output);
            Require(File.ReadAllBytes(downloaded).SequenceEqual(installer), "Downloaded installer changed");
        } finally {
            if (Directory.Exists(output)) Directory.Delete(output, true);
        }

        var badManifest = JsonSerializer.SerializeToUtf8Bytes(new {
            schemaVersion = 1,
            channel = "stable",
            version = "0.3.51",
            build = 51,
            publishedAt = DateTimeOffset.UtcNow,
            installer = new { url = server.BaseUri + "setup.exe", size = installer.Length, sha256 = new string('0', 64), signerThumbprint = (string?)null },
            releaseNotesUrl = "https://codex.air-inc.top/download/windows/notes.html",
        });
        var badSignature = key.SignData(badManifest, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        server.Add("/bad.json", badManifest, "application/json");
        server.Add("/bad.json.sig", Encoding.ASCII.GetBytes(Convert.ToBase64String(badSignature)), "text/plain");
        using var badService = new UpdateService(new Uri(server.BaseUri + "bad.json"), 49, publicKey, true);
        var badRelease = await badService.CheckAsync() ?? throw new InvalidOperationException("Bad release was not detected");
        var badOutput = Path.Combine(Path.GetTempPath(), "codex-update-bad-" + Guid.NewGuid().ToString("N"));
        try {
            await badService.DownloadAndVerifyAsync(badRelease, badOutput);
            throw new InvalidOperationException("Bad SHA-256 was accepted");
        } catch (UpdateException error) when (error.Message.Contains("SHA-256", StringComparison.Ordinal)) {
        } finally {
            if (Directory.Exists(badOutput)) Directory.Delete(badOutput, true);
        }

        var tampered = manifest.ToArray();
        tampered[^2] ^= 1;
        server.Add("/tampered.json", tampered, "application/json");
        server.Add("/tampered.json.sig", Encoding.ASCII.GetBytes(Convert.ToBase64String(signature)), "text/plain");
        using var tamperedService = new UpdateService(new Uri(server.BaseUri + "tampered.json"), 49, publicKey, true);
        try {
            await tamperedService.CheckAsync();
            throw new InvalidOperationException("Tampered manifest signature was accepted");
        } catch (UpdateException error) when (error.Message.Contains("签名", StringComparison.Ordinal)) {
        }
    }

    private static byte[] ReplaceInstallerUrl(byte[] manifest, string url)
    {
        using var doc = JsonDocument.Parse(manifest);
        var root = JsonSerializer.Deserialize<Dictionary<string, object>>(manifest)!;
        root["installer"] = new Dictionary<string, object?> {
            ["url"] = url,
            ["size"] = doc.RootElement.GetProperty("installer").GetProperty("size").GetInt64(),
            ["sha256"] = doc.RootElement.GetProperty("installer").GetProperty("sha256").GetString(),
            ["signerThumbprint"] = null,
        };
        return JsonSerializer.SerializeToUtf8Bytes(root);
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}

internal sealed class LocalHttpServer : IAsyncDisposable
{
    private readonly HttpListener listener = new();
    private readonly Dictionary<string, (byte[] Body, string ContentType)> routes = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource stop = new();
    private readonly Task loop;

    public LocalHttpServer()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        BaseUri = $"http://127.0.0.1:{port}/";
        listener.Prefixes.Add(BaseUri);
        listener.Start();
        loop = AcceptAsync();
    }

    public string BaseUri { get; }

    public void Add(string path, byte[] body, string contentType) => routes[path.TrimStart('/')] = (body, contentType);

    private async Task AcceptAsync()
    {
        try {
            while (!stop.IsCancellationRequested) {
                var context = await listener.GetContextAsync().WaitAsync(stop.Token);
                _ = ServeAsync(context);
            }
        } catch (OperationCanceledException) {
        } catch (ObjectDisposedException) {
        } catch (HttpListenerException) when (stop.IsCancellationRequested) {
        }
    }

    private async Task ServeAsync(HttpListenerContext context)
    {
        try {
            var path = context.Request.Url?.AbsolutePath.TrimStart('/') ?? "";
            var found = routes.TryGetValue(path, out var route);
            var body = found ? route.Body : Encoding.UTF8.GetBytes("not found");
            context.Response.StatusCode = found ? 200 : 404;
            context.Response.ContentType = found ? route.ContentType : "text/plain";
            context.Response.ContentLength64 = body.Length;
            await context.Response.OutputStream.WriteAsync(body, stop.Token);
            context.Response.Close();
        } catch (OperationCanceledException) {
            context.Response.Abort();
        }
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        listener.Close();
        await loop;
        stop.Dispose();
    }
}
