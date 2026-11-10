using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CodexPhone;

internal sealed class UpdateException : Exception
{
    public UpdateException(string message, Exception? inner = null) : base(message, inner) { }
}

internal sealed class UpdateRelease
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; init; }

    [JsonPropertyName("channel")]
    public string Channel { get; init; } = "";

    [JsonPropertyName("version")]
    public string Version { get; init; } = "";

    [JsonPropertyName("build")]
    public int Build { get; init; }

    [JsonPropertyName("publishedAt")]
    public DateTimeOffset PublishedAt { get; init; }

    [JsonPropertyName("installer")]
    public UpdateInstaller Installer { get; init; } = new();

    [JsonPropertyName("releaseNotesUrl")]
    public string? ReleaseNotesUrl { get; init; }
}

internal sealed class UpdateInstaller
{
    [JsonPropertyName("url")]
    public string Url { get; init; } = "";

    [JsonPropertyName("size")]
    public long Size { get; init; }

    [JsonPropertyName("sha256")]
    public string Sha256 { get; init; } = "";

    [JsonPropertyName("signerThumbprint")]
    public string? SignerThumbprint { get; init; }
}

internal sealed class UpdateService : IDisposable
{
    private const int ManifestSchemaVersion = 1;
    private const int MaxManifestBytes = 64 * 1024;
    private const int MaxSignatureBytes = 1024;
    private const long MaxInstallerBytes = 512L * 1024 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private readonly HttpClient http;
    private readonly Uri feedUri;
    private readonly byte[] publicKey;
    private readonly bool allowInsecureForTests;

    public int CurrentBuild { get; }

    public UpdateService(Uri feedUri, int currentBuild, string publicKeyBase64, bool allowInsecureForTests = false)
    {
        this.feedUri = ValidateHttpsUri(feedUri, "更新源", allowInsecureForTests);
        this.CurrentBuild = currentBuild > 0 ? currentBuild : throw new ArgumentOutOfRangeException(nameof(currentBuild));
        this.publicKey = Convert.FromBase64String(publicKeyBase64);
        this.allowInsecureForTests = allowInsecureForTests;

        using var key = ECDsa.Create();
        key.ImportSubjectPublicKeyInfo(this.publicKey, out var bytesRead);
        if (bytesRead != this.publicKey.Length) throw new CryptographicException("Invalid update public key");

        var handler = new HttpClientHandler {
            AllowAutoRedirect = true,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
        };
        http = new HttpClient(handler) {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"codex-phone-assistant/{BuildInfo.Version}");
    }

    public async Task<UpdateRelease?> CheckAsync(CancellationToken cancellationToken = default)
    {
        using var checkTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        checkTimeout.CancelAfter(TimeSpan.FromSeconds(20));
        try {
            var manifestBytes = await GetBytesAsync(feedUri, MaxManifestBytes, checkTimeout.Token);
            var signatureUri = new Uri(feedUri.AbsoluteUri + ".sig");
            var signatureBytes = await GetBytesAsync(signatureUri, MaxSignatureBytes, checkTimeout.Token);
            VerifyManifestSignature(manifestBytes, signatureBytes);

            UpdateRelease? release;
            try {
                release = JsonSerializer.Deserialize<UpdateRelease>(manifestBytes, JsonOptions);
            } catch (JsonException error) {
                throw new UpdateException("更新清单格式无效。", error);
            }
            ValidateRelease(release);
            return release!.Build > CurrentBuild ? release : null;
        } catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) {
            throw new UpdateException("检查更新超时。");
        } catch (HttpRequestException error) {
            throw new UpdateException("无法连接更新服务器。", error);
        }
    }

    public async Task<string> DownloadAndVerifyAsync(UpdateRelease release, string updateDirectory, IProgress<int>? progress = null, CancellationToken cancellationToken = default)
    {
        ValidateRelease(release);
        Directory.CreateDirectory(updateDirectory);
        var destination = Path.Combine(updateDirectory, $"codex-phone-assistant-{release.Version}-setup.exe");
        var partial = destination + ".partial";
        File.Delete(partial);
        try {
            using var response = await SendAsync(new HttpRequestMessage(HttpMethod.Get, ValidateHttpsUri(new Uri(release.Installer.Url), "安装包地址", allowInsecureForTests)), HttpCompletionOption.ResponseHeadersRead, TimeSpan.FromMinutes(30), cancellationToken);
            if (response.Content.Headers.ContentLength is long declared && declared > MaxInstallerBytes) throw new UpdateException("更新包超过允许的大小。");

            long total = response.Content.Headers.ContentLength ?? release.Installer.Size;
            long written = 0;
            using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var target = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[128 * 1024];
            while (true) {
                var read = await source.ReadAsync(buffer.AsMemory(), cancellationToken);
                if (read == 0) break;
                written += read;
                if (written > MaxInstallerBytes || written > release.Installer.Size) throw new UpdateException("更新包大小与清单不一致。");
                hash.AppendData(buffer, 0, read);
                await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                if (total > 0) progress?.Report((int)Math.Clamp(written * 100 / total, 0, 99));
            }
            await target.FlushAsync(cancellationToken);
            if (written != release.Installer.Size) throw new UpdateException("更新包大小与清单不一致。");
            var actual = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(actual), Encoding.ASCII.GetBytes(release.Installer.Sha256.ToLowerInvariant()))) {
                throw new UpdateException("更新包 SHA-256 校验失败。");
            }
            target.Close();
            File.Move(partial, destination, true);
            ValidateSigner(destination, release);
            progress?.Report(100);
            return destination;
        } catch (OperationCanceledException) {
            throw;
        } catch (UpdateException) {
            throw;
        } catch (Exception error) {
            throw new UpdateException("下载更新失败。", error);
        } finally {
            if (File.Exists(partial)) {
                try { File.Delete(partial); } catch { }
            }
        }
    }

    public void LaunchUpdater(string updaterScript, string installerPath, UpdateRelease release, string appPath, string updateDirectory)
    {
        if (!File.Exists(updaterScript)) throw new UpdateException("安装包中缺少更新助手。");
        if (!File.Exists(installerPath)) throw new UpdateException("下载的更新包不存在。");
        if (!File.Exists(appPath)) throw new UpdateException("无法确定当前应用路径。");
        Directory.CreateDirectory(updateDirectory);

        var stagedUpdater = Path.Combine(updateDirectory, "updater.ps1");
        File.Copy(updaterScript, stagedUpdater, true);
        var logPath = Path.Combine(updateDirectory, "update.log");
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(powershell)) throw new UpdateException("系统缺少 Windows PowerShell。");

        var start = new ProcessStartInfo(powershell) {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = updateDirectory,
        };
        start.ArgumentList.Add("-NoLogo");
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-NonInteractive");
        start.ArgumentList.Add("-ExecutionPolicy");
        start.ArgumentList.Add("Bypass");
        start.ArgumentList.Add("-File");
        start.ArgumentList.Add(stagedUpdater);
        start.ArgumentList.Add("-ParentPid");
        start.ArgumentList.Add(Environment.ProcessId.ToString());
        start.ArgumentList.Add("-Installer");
        start.ArgumentList.Add(installerPath);
        start.ArgumentList.Add("-ExpectedSha256");
        start.ArgumentList.Add(release.Installer.Sha256);
        start.ArgumentList.Add("-AppPath");
        start.ArgumentList.Add(appPath);
        start.ArgumentList.Add("-LogPath");
        start.ArgumentList.Add(logPath);
        using var updaterProcess = Process.Start(start) ?? throw new UpdateException("无法启动更新助手。");
    }

    public static string UpdateDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "codex-phone-assistant",
        "Updates");

    private async Task<byte[]> GetBytesAsync(Uri uri, int maximumBytes, CancellationToken cancellationToken)
    {
        using var response = await SendAsync(new HttpRequestMessage(HttpMethod.Get, uri), HttpCompletionOption.ResponseHeadersRead, TimeSpan.FromSeconds(20), cancellationToken);
        if (response.Content.Headers.ContentLength is long length && length > maximumBytes) throw new UpdateException("更新响应过大。");
        using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        while (true) {
            var read = await stream.ReadAsync(buffer.AsMemory(), cancellationToken);
            if (read == 0) break;
            if (output.Length + read > maximumBytes) throw new UpdateException("更新响应过大。");
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, HttpCompletionOption completion, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var requestTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        requestTimeout.CancelAfter(timeout);
        HttpResponseMessage response;
        try {
            response = await http.SendAsync(request, completion, requestTimeout.Token);
        } catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) {
            throw new UpdateException("更新请求超时。");
        }
        if (!response.IsSuccessStatusCode) {
            response.Dispose();
            throw new UpdateException($"更新服务器返回 HTTP {(int)response.StatusCode}。");
        }
        if (response.RequestMessage?.RequestUri is Uri finalUri) ValidateHttpsUri(finalUri, "更新地址", allowInsecureForTests);
        return response;
    }

    private void VerifyManifestSignature(byte[] manifest, byte[] signatureText)
        => VerifyDetachedSignature(manifest, signatureText, publicKey);

    internal static void VerifyDetachedSignature(byte[] manifest, byte[] signatureText, string publicKeyBase64)
        => VerifyDetachedSignature(manifest, signatureText, Convert.FromBase64String(publicKeyBase64));

    private static void VerifyDetachedSignature(byte[] manifest, byte[] signatureText, byte[] publicKey)
    {
        byte[] signature;
        try {
            signature = Convert.FromBase64String(Encoding.ASCII.GetString(signatureText).Trim());
        } catch (FormatException error) {
            throw new UpdateException("更新清单签名格式无效。", error);
        }
        using var key = ECDsa.Create();
        key.ImportSubjectPublicKeyInfo(publicKey, out _);
        if (!key.VerifyData(manifest, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) {
            throw new UpdateException("更新清单签名无效。");
        }
    }

    private void ValidateRelease(UpdateRelease? release)
    {
        if (release is null || (release.SchemaVersion != ManifestSchemaVersion && release.SchemaVersion != 2) || release.Channel != "stable") throw new UpdateException("更新清单版本或通道无效。");
        if (!System.Text.RegularExpressions.Regex.IsMatch(release.Version, @"^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})(?:[-+][0-9A-Za-z.-]+)?$")) throw new UpdateException("更新版本号无效。");
        if (release.Build <= 0) throw new UpdateException("更新构建号无效。");
        if (release.PublishedAt == default) throw new UpdateException("更新发布时间无效。");
        if (release.SchemaVersion == 2) return;
        if (release.Installer is null || release.Installer.Size <= 0 || release.Installer.Size > MaxInstallerBytes) throw new UpdateException("更新包大小无效。");
        ValidateHttpsUri(new Uri(release.Installer.Url), "安装包地址", allowInsecureForTests);
        if (!System.Text.RegularExpressions.Regex.IsMatch(release.Installer.Sha256 ?? "", "^[0-9a-fA-F]{64}$")) throw new UpdateException("更新包摘要无效。");
        if (!string.IsNullOrWhiteSpace(release.Installer.SignerThumbprint) &&
            !System.Text.RegularExpressions.Regex.IsMatch(release.Installer.SignerThumbprint, "^[0-9a-fA-F]{40,64}$")) throw new UpdateException("安装包签名指纹无效。");
        if (!string.IsNullOrWhiteSpace(release.ReleaseNotesUrl)) ValidateHttpsUri(new Uri(release.ReleaseNotesUrl), "版本说明地址", allowInsecureForTests);
    }

    private static void ValidateSigner(string installerPath, UpdateRelease release)
    {
        if (string.IsNullOrWhiteSpace(release.Installer.SignerThumbprint)) return;
        try {
            using var certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(installerPath));
            if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(certificate.Thumbprint.ToLowerInvariant()),
                Encoding.ASCII.GetBytes(release.Installer.SignerThumbprint.ToLowerInvariant()))) {
                throw new UpdateException("安装包签名者与更新清单不一致。");
            }
        } catch (UpdateException) {
            throw;
        } catch (CryptographicException error) {
            throw new UpdateException("安装包签名无效。", error);
        }
    }

    private static Uri ValidateHttpsUri(Uri? uri, string label, bool allowInsecureForTests)
    {
        if (uri is null || !uri.IsAbsoluteUri || (uri.Scheme != Uri.UriSchemeHttps && !(allowInsecureForTests && uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback))) {
            throw new UpdateException($"{label}必须使用 HTTPS。");
        }
        if (!string.IsNullOrEmpty(uri.UserInfo)) throw new UpdateException($"{label}不能包含用户凭据。");
        return uri;
    }

    public void Dispose() => http.Dispose();
}

internal static class BuildInfo
{
    private static readonly IReadOnlyDictionary<string, string> Metadata =
        typeof(BuildInfo).Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyMetadataAttribute), false)
            .Cast<System.Reflection.AssemblyMetadataAttribute>()
            .Where(attribute => attribute.Key is not null && attribute.Value is not null)
            .ToDictionary(attribute => attribute.Key!, attribute => attribute.Value!);

    public static string Version => typeof(BuildInfo).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
    public static int Build => int.TryParse(Metadata.GetValueOrDefault("CodexPhone.BuildNumber"), out var value) ? value : 0;
    public static Uri? UpdateFeed => Uri.TryCreate(Metadata.GetValueOrDefault("CodexPhone.UpdateFeedUrl"), UriKind.Absolute, out var uri) ? uri : null;
    public static string UpdatePublicKey => Metadata.GetValueOrDefault("CodexPhone.UpdatePublicKey") ?? "";
    public static string? ReleaseNotesUrl => Metadata.GetValueOrDefault("CodexPhone.ReleaseNotesUrl");
}
