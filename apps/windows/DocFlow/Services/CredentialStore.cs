using System.Runtime.InteropServices;
using System.Text;

namespace DocFlow.Services;

/// <summary>
/// API keys in Windows Credential Manager ("Windows 凭据"), scoped to the
/// current user. Names follow the engine: <c>mineru</c> and
/// <c>provider:&lt;id&gt;</c>. The engine only ever receives them in memory.
/// </summary>
public static partial class CredentialStore
{
    public const string Mineru = "mineru";

    private const string Prefix = "DocFlow/";
    private const uint CRED_TYPE_GENERIC = 1;
    private const uint CRED_PERSIST_LOCAL_MACHINE = 2;
    private const int ERROR_NOT_FOUND = 1168;

    public static string ProviderName(string providerId) => $"provider:{providerId}";

    private static string Target(string name) => Prefix + name;

    public static string? Read(string name)
    {
        if (!CredReadW(Target(name), CRED_TYPE_GENERIC, 0, out var pointer))
        {
            return null;
        }

        try
        {
            return BlobText(Marshal.PtrToStructure<CREDENTIAL>(pointer));
        }
        finally
        {
            CredFree(pointer);
        }
    }

    public static void Write(string name, string secret)
    {
        var blob = Encoding.Unicode.GetBytes(secret);
        var blobPointer = Marshal.AllocHGlobal(blob.Length);
        var target = Marshal.StringToHGlobalUni(Target(name));
        var user = Marshal.StringToHGlobalUni(Environment.UserName);
        try
        {
            Marshal.Copy(blob, 0, blobPointer, blob.Length);
            var credential = new CREDENTIAL
            {
                Type = CRED_TYPE_GENERIC,
                TargetName = target,
                CredentialBlobSize = (uint)blob.Length,
                CredentialBlob = blobPointer,
                Persist = CRED_PERSIST_LOCAL_MACHINE,
                UserName = user,
            };
            if (!CredWriteW(ref credential, 0))
            {
                throw new InvalidOperationException($"无法写入 Windows 凭据（错误 {Marshal.GetLastWin32Error()}）");
            }
        }
        finally
        {
            Array.Clear(blob);
            Marshal.FreeHGlobal(blobPointer);
            Marshal.FreeHGlobal(target);
            Marshal.FreeHGlobal(user);
        }
    }

    public static void Delete(string name)
    {
        if (!CredDeleteW(Target(name), CRED_TYPE_GENERIC, 0) && Marshal.GetLastWin32Error() != ERROR_NOT_FOUND)
        {
            throw new InvalidOperationException($"无法删除 Windows 凭据（错误 {Marshal.GetLastWin32Error()}）");
        }
    }

    /// <summary>The MinerU key and every stored provider key, by engine name.</summary>
    public static Dictionary<string, string?> ReadAll()
    {
        var secrets = new Dictionary<string, string?> { [Mineru] = Read(Mineru) };
        if (!CredEnumerateW(Prefix + "provider:*", 0, out var count, out var list))
        {
            return secrets;
        }
        try
        {
            for (var index = 0; index < count; index++)
            {
                var credential = Marshal.PtrToStructure<CREDENTIAL>(Marshal.ReadIntPtr(list, index * IntPtr.Size));
                var target = Marshal.PtrToStringUni(credential.TargetName) ?? "";
                if (target.StartsWith(Prefix + "provider:", StringComparison.Ordinal))
                {
                    secrets[target[Prefix.Length..]] = BlobText(credential);
                }
            }
        }
        finally
        {
            CredFree(list);
        }
        return secrets;
    }

    private static string? BlobText(CREDENTIAL credential)
    {
        if (credential.CredentialBlobSize == 0 || credential.CredentialBlob == IntPtr.Zero)
        {
            return null;
        }
        var bytes = new byte[credential.CredentialBlobSize];
        Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
        try
        {
            return Encoding.Unicode.GetString(bytes);
        }
        finally
        {
            Array.Clear(bytes);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CREDENTIAL
    {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        // FILETIME as two DWORDs keeps the struct blittable for LibraryImport.
        public uint LastWrittenLow;
        public uint LastWrittenHigh;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [LibraryImport("advapi32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

    [LibraryImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CredWriteW(ref CREDENTIAL credential, uint flags);

    [LibraryImport("advapi32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CredDeleteW(string target, uint type, uint flags);

    [LibraryImport("advapi32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CredEnumerateW(string filter, uint flags, out int count, out IntPtr credentials);

    [LibraryImport("advapi32.dll")]
    private static partial void CredFree(IntPtr buffer);
}
