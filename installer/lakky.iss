; Lakky — Inno Setup installer script
; Requires Inno Setup 6.3+ for PNG WizardImageFile / modern wizard style.
; Build:  iscc installer\lakky.iss   (after `bun run build`)

#define MyAppName        "Lakky"
#define MyAppVersion     "1.0.3"
#define MyAppPublisher   "Laknicek"
#define MyAppURL         "https://github.com/Laknicek/lakky"
#define MyAppExeName     "launcher.exe"
#define MyAppExePath     "bin\" + MyAppExeName

[Setup]
AppId={{B7C5D6E8-9F1A-4E5B-8C2A-7D8F5B3E9A12}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\artifacts
OutputBaseFilename=Lakky-Setup-{#MyAppVersion}
SetupIconFile=..\assets\icon.ico
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
WizardResizable=no
WizardImageFile=wizard-side.png
WizardSmallImageFile=wizard-small.png
WizardImageAlphaFormat=defined
UninstallDisplayIcon={app}\{#MyAppExePath}
UninstallDisplayName={#MyAppName} {#MyAppVersion}
ChangesAssociations=yes
CloseApplications=force
RestartApplications=no
; ANSI defaults to bytes; force UTF-8 string handling for state.json
DisableWelcomePage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon";   Description: "Create a &desktop shortcut";                    GroupDescription: "Additional shortcuts:"
Name: "quicklaunchicon"; Description: "Create a &quick launch shortcut";              GroupDescription: "Additional shortcuts:"; Flags: unchecked; OnlyBelowVersion: 6.1
Name: "associate_audio"; Description: "Associate &audio files (.mp3 .flac .m4a .ogg .opus .wav .aac)";     GroupDescription: "File associations:"
Name: "associate_video"; Description: "Associate &video files (.mp4 .mkv .webm .mov .avi)";                GroupDescription: "File associations:"; Flags: unchecked

[Files]
; Whole Electrobun bundle — bin/, Resources/, the lot.
Source: "..\build\stable-win-x64\{#MyAppName}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}";          Filename: "{app}\{#MyAppExePath}"; WorkingDir: "{app}\bin"; IconFilename: "{app}\bin\launcher.exe"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}";    Filename: "{app}\{#MyAppExePath}"; WorkingDir: "{app}\bin"; IconFilename: "{app}\bin\launcher.exe"; Tasks: desktopicon
Name: "{userappdata}\Microsoft\Internet Explorer\Quick Launch\{#MyAppName}"; Filename: "{app}\{#MyAppExePath}"; WorkingDir: "{app}\bin"; Tasks: quicklaunchicon

[Registry]
; --- File associations (audio) ---
Root: HKA; Subkey: "Software\Classes\.mp3\OpenWithProgids"; ValueType: string; ValueName: "Lakky.AudioFile"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associate_audio
Root: HKA; Subkey: "Software\Classes\.flac\OpenWithProgids"; ValueType: string; ValueName: "Lakky.AudioFile"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associate_audio
Root: HKA; Subkey: "Software\Classes\.m4a\OpenWithProgids"; ValueType: string; ValueName: "Lakky.AudioFile"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associate_audio
Root: HKA; Subkey: "Software\Classes\.ogg\OpenWithProgids"; ValueType: string; ValueName: "Lakky.AudioFile"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associate_audio
Root: HKA; Subkey: "Software\Classes\.opus\OpenWithProgids"; ValueType: string; ValueName: "Lakky.AudioFile"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associate_audio
Root: HKA; Subkey: "Software\Classes\.wav\OpenWithProgids"; ValueType: string; ValueName: "Lakky.AudioFile"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associate_audio
Root: HKA; Subkey: "Software\Classes\.aac\OpenWithProgids"; ValueType: string; ValueName: "Lakky.AudioFile"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associate_audio
Root: HKA; Subkey: "Software\Classes\Lakky.AudioFile"; ValueType: string; ValueName: ""; ValueData: "Lakky audio"; Flags: uninsdeletekey; Tasks: associate_audio
Root: HKA; Subkey: "Software\Classes\Lakky.AudioFile\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExePath}"",0"; Tasks: associate_audio
Root: HKA; Subkey: "Software\Classes\Lakky.AudioFile\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExePath}"" ""%1"""; Tasks: associate_audio

; --- File associations (video) ---
Root: HKA; Subkey: "Software\Classes\.mp4\OpenWithProgids";  ValueType: string; ValueName: "Lakky.VideoFile"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associate_video
Root: HKA; Subkey: "Software\Classes\.mkv\OpenWithProgids";  ValueType: string; ValueName: "Lakky.VideoFile"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associate_video
Root: HKA; Subkey: "Software\Classes\.webm\OpenWithProgids"; ValueType: string; ValueName: "Lakky.VideoFile"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associate_video
Root: HKA; Subkey: "Software\Classes\.mov\OpenWithProgids";  ValueType: string; ValueName: "Lakky.VideoFile"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associate_video
Root: HKA; Subkey: "Software\Classes\.avi\OpenWithProgids";  ValueType: string; ValueName: "Lakky.VideoFile"; ValueData: ""; Flags: uninsdeletevalue; Tasks: associate_video
Root: HKA; Subkey: "Software\Classes\Lakky.VideoFile"; ValueType: string; ValueName: ""; ValueData: "Lakky video"; Flags: uninsdeletekey; Tasks: associate_video
Root: HKA; Subkey: "Software\Classes\Lakky.VideoFile\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExePath}"",0"; Tasks: associate_video
Root: HKA; Subkey: "Software\Classes\Lakky.VideoFile\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExePath}"" ""%1"""; Tasks: associate_video

[Run]
; Interactive install — shows a "Launch Lakky" checkbox on the final wizard page.
Filename: "{app}\{#MyAppExePath}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
; Silent / very-silent install — auto-launches the new build. Used by the
; in-app updater so the user goes from "click install" to a running new
; version with no further interaction.
Filename: "{app}\{#MyAppExePath}"; Flags: nowait skipifnotsilent

[Code]
var
  MusicFolderPage: TInputDirWizardPage;

procedure InitializeWizard();
begin
  MusicFolderPage := CreateInputDirPage(
    wpSelectDir,
    'Music library folder',
    'Pick where Lakky should keep your music.',
    'When you import audio files in Lakky, copies are organized into this folder as Artist / Album / Title.ext. You can change this anytime in Settings → Library folder.',
    False,
    'Lakky'
  );
  MusicFolderPage.Add('Library folder:');
  MusicFolderPage.Values[0] := ExpandConstant('{userdocs}\Lakky');
end;

function PathReplaceBackslashes(const S: String): String;
var
  I: Integer;
begin
  Result := '';
  for I := 1 to Length(S) do
    if S[I] = '\' then Result := Result + '\\' else Result := Result + S[I];
end;

procedure WriteLibraryFolderHint(const LibPath: String);
var
  StatePath, JsonStr: String;
  Existing: AnsiString;
begin
  StatePath := ExpandConstant('{userappdata}\Lakky\state.json');
  ForceDirectories(ExtractFileDir(StatePath));
  if FileExists(StatePath) then begin
    // Don't clobber an existing config (returning user re-running the
    // installer). Leave their state untouched.
    if LoadStringFromFile(StatePath, Existing) then begin
      if Pos('"libraryFolder"', String(Existing)) > 0 then exit;
    end;
  end;
  JsonStr := '{"libraryFolder":"' + PathReplaceBackslashes(LibPath) + '"}';
  SaveStringToFile(StatePath, JsonStr, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  LibFolder: String;
begin
  if CurStep = ssPostInstall then begin
    LibFolder := MusicFolderPage.Values[0];
    ForceDirectories(LibFolder);
    WriteLibraryFolderHint(LibFolder);
  end;
end;

function NeedRestart(): Boolean;
begin
  Result := False;
end;
