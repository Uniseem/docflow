using System.Globalization;
using Microsoft.UI.Xaml;

namespace DocFlow.Helpers;

/// <summary>Display text shared by the views (also used from x:Bind).</summary>
public static class Format
{
    private static readonly CultureInfo Chinese = CultureInfo.GetCultureInfo("zh-CN");

    public static string Size(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:0} KB",
        < 1024L * 1024 * 1024 => $"{bytes / 1024.0 / 1024.0:0.0} MB",
        _ => $"{bytes / 1024.0 / 1024.0 / 1024.0:0.00} GB",
    };

    public static string OptionalSize(long? bytes) => bytes is { } value ? Size(value) : "—";

    public static string Date(DateTimeOffset value) =>
        value.ToLocalTime().ToString("yyyy-MM-dd HH:mm", Chinese);

    public static string Time(DateTimeOffset value) =>
        value.ToLocalTime().ToString("HH:mm:ss", Chinese);

    public static string RelativeDate(DateTimeOffset value)
    {
        var local = value.ToLocalTime();
        var now = DateTimeOffset.Now;
        if (local.Date == now.Date)
        {
            return "今天 " + local.ToString("HH:mm", Chinese);
        }
        if (local.Date == now.Date.AddDays(-1))
        {
            return "昨天 " + local.ToString("HH:mm", Chinese);
        }
        return local.Year == now.Year
            ? local.ToString("M月d日 HH:mm", Chinese)
            : local.ToString("yyyy年M月d日", Chinese);
    }

    public static string Duration(TimeSpan span)
    {
        if (span < TimeSpan.Zero)
        {
            span = TimeSpan.Zero;
        }
        return span.TotalSeconds < 60
            ? $"{(int)span.TotalSeconds} 秒"
            : span.TotalHours < 1
                ? $"{(int)span.TotalMinutes} 分 {span.Seconds} 秒"
                : $"{(int)span.TotalHours} 小时 {span.Minutes} 分";
    }

    public static string Mode(string mode) => mode == "pdf2zh" ? "PDF 原生翻译" : "MinerU 解析翻译";

    /// <summary>What translated a document; older documents only know a tier.</summary>
    public static string Translator(string? label, int tier) => label is { Length: > 0 }
        ? label
        : tier switch
        {
            1 => "Google 翻译",
            2 => "DeepSeek",
            3 => "DeepSeek 思考模式",
            _ => "未知翻译服务",
        };

    public static string ProviderType(string type) => type switch
    {
        "openai" => "OpenAI 兼容",
        "azure" => "Azure OpenAI",
        "anthropic" => "Anthropic",
        "gemini" => "Gemini",
        _ => type,
    };

    /// <summary>The request URL the engine derives from an API address (see engine/src/providers.rs).</summary>
    public static string ChatEndpoint(string type, string baseUrl, string? model)
    {
        var trimmed = baseUrl.Trim().TrimEnd('/');
        if (trimmed.Length == 0)
        {
            return "";
        }
        static string Join(string left, string right) => left.TrimEnd('/') + "/" + right.TrimStart('/');
        return type switch
        {
            "anthropic" => trimmed.EndsWith("/v1", StringComparison.Ordinal) ? Join(trimmed, "messages") : Join(trimmed, "v1/messages"),
            "gemini" => Join(
                trimmed.EndsWith("/v1", StringComparison.Ordinal) || trimmed.EndsWith("/v1beta", StringComparison.Ordinal) ? trimmed : Join(trimmed, "v1beta"),
                $"models/{model ?? "模型"}:generateContent"),
            _ => Join(trimmed, "chat/completions"),
        };
    }

    public static string Status(string status) => status switch
    {
        "queued" => "排队中",
        "processing" => "处理中",
        "retrying" => "等待重试",
        "completed" => "已完成",
        "failed" => "失败",
        "cancelled" => "已取消",
        _ => status,
    };

    /// <summary>Segoe Fluent Icons glyph for a document status.</summary>
    public static string StatusGlyph(string status) => status switch
    {
        "completed" => "\uEC61", // CompletedSolid
        "failed" => "\uEB90", // StatusErrorFull
        "cancelled" => "\uE711", // Cancel
        "retrying" => "\uE72C", // Refresh
        _ => "\uE823", // Recent
    };

    /// <summary>PDF glyph for the native route, document glyph for MinerU.</summary>
    public static string ModeGlyph(string mode) => mode == "pdf2zh" ? "\uEA90" : "\uE8A5";

    public static Visibility Show(bool value) => value ? Visibility.Visible : Visibility.Collapsed;

    public static Visibility Hide(bool value) => value ? Visibility.Collapsed : Visibility.Visible;

    public static bool Not(bool value) => !value;

    public static bool HasText(string? value) => !string.IsNullOrWhiteSpace(value);

    public static Visibility ShowText(string? value) =>
        string.IsNullOrWhiteSpace(value) ? Visibility.Collapsed : Visibility.Visible;
}
