; DocFlow for Windows: a per-user setup program (no administrator rights),
; built by apps\windows\build.ps1 -Installer from apps\windows\dist\DocFlow.
; Needs Inno Setup 6.6 or later:
;
;   ISCC.exe /DAppVersion=3.0.1 apps\windows\installer\DocFlow.iss
;
; This file is UTF-8 with a byte order mark, which Inno Setup needs for the
; Chinese text below.

#if Ver < EncodeVer(6, 6, 0)
  #error Inno Setup 6.6 or later is required
#endif
#ifndef AppVersion
  #error Pass the version: ISCC /DAppVersion=<version> DocFlow.iss
#endif
#ifndef AppDir
  #define AppDir "..\dist\DocFlow"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

[Setup]
; Never change AppId: an update finds the installed DocFlow by it and
; replaces it, and Windows' uninstall list removes the right program.
AppId={{682055C5-11A6-4391-8471-19762DD96A4C}
AppName=DocFlow
AppVersion={#AppVersion}
AppVerName=DocFlow {#AppVersion}
AppPublisher=DocFlow contributors
AppPublisherURL=https://github.com/Uniseem/docflow
AppSupportURL=https://github.com/Uniseem/docflow/issues
AppUpdatesURL=https://github.com/Uniseem/docflow/releases
AppCopyright=© 2026 DocFlow contributors
VersionInfoVersion={#AppVersion}
VersionInfoProductName=DocFlow
VersionInfoDescription=DocFlow 安装程序
; For the current user only: %LOCALAPPDATA%\Programs\DocFlow, no UAC prompt.
PrivilegesRequired=lowest
DefaultDirName={autopf}\DocFlow
DisableDirPage=auto
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
WizardStyle=modern dynamic windows11
SetupIconFile=..\DocFlow\Assets\AppIcon.ico
WizardSmallImageFile=..\DocFlow\Assets\AppIcon.png
UninstallDisplayIcon={app}\DocFlow.exe
UninstallDisplayName=DocFlow
OutputDir={#OutputDir}
OutputBaseFilename=DocFlow-win-x64-setup
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
LZMANumBlockThreads=4
; A running DocFlow is asked to close first (Program.cs holds this mutex);
; its translations resume from their checkpoints at the next start.
AppMutex=DocFlow.Running
CloseApplications=yes
CloseApplicationsFilter=*.exe,*.dll,*.pyd
RestartApplications=no
ShowLanguageDialog=no

[Languages]
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; The bundled Python runtime is replaced as a whole, so files of an older
; runtime never mix with the new one.
Type: filesandordirs; Name: "{app}\engine"

[Files]
Source: "{#AppDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\DocFlow"; Filename: "{app}\DocFlow.exe"
Name: "{autodesktop}\DocFlow"; Filename: "{app}\DocFlow.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\DocFlow.exe"; Description: "{cm:LaunchProgram,DocFlow}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Anything the runtime created next to itself. The document library and
; the API keys (Credential Manager) are the user's and stay.
Type: filesandordirs; Name: "{app}\engine"

[Code]
const
  WebView2Client = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Download = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

// Installed per machine (32-bit registry view) or per user, as Microsoft
// documents for detecting the Evergreen WebView2 Runtime.
function HasWebView2(Root: Integer): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(Root, WebView2Client, 'pv', Version)
    and (Version <> '') and (Version <> '0.0.0.0');
end;

// Windows 11 includes WebView2; an older Windows 10 may not. DocFlow runs
// without it, but cannot show translated documents.
procedure CurStepChanged(CurStep: TSetupStep);
var
  ErrorCode: Integer;
begin
  if (CurStep = ssPostInstall) and not WizardSilent
    and not HasWebView2(HKLM32) and not HasWebView2(HKCU) then
  begin
    if MsgBox('DocFlow 显示译文需要 Microsoft Edge WebView2 运行时，这台电脑还没有安装。' + #13#10#13#10 +
      '点“确定”下载微软提供的安装程序，运行它即可完成安装。', mbInformation, MB_OKCANCEL) = IDOK then
      ShellExec('open', WebView2Download, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
  end;
end;
