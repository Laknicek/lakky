import { existsSync, mkdirSync, writeFileSync, unlinkSync, cpSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";
import { rcedit } from "rcedit";

const ROOT = resolve(import.meta.dir, "..");
const DIST_DIR = join(ROOT, "dist");
const DEV_BIN_DIR = join(ROOT, "build", "dev-win-x64", "Lakky-dev", "bin");
const DEV_RES_DIR = join(ROOT, "build", "dev-win-x64", "Lakky-dev", "Resources");
const PKG_DIR = join(ROOT, "build", "package", "Lakky");
const ARTIFACTS_DIR = join(ROOT, "artifacts");
const ICON_PATH = join(ROOT, "assets", "icon.ico");
const TRAY_PNG_PATH = join(ROOT, "assets", "tray-32.png");
const VERSION = "1.1.0";

console.log(`[build-installer] Starting packaging for Lakky v${VERSION}...`);

// Ensure dev binaries exist
if (!existsSync(DEV_BIN_DIR)) {
	console.log("[build-installer] Generating base runtime binaries via electrobun dev...");
	execSync("electrobun dev", { stdio: "inherit", timeout: 8000 });
}

// Clean and create package directory
if (existsSync(PKG_DIR)) {
	rmSync(PKG_DIR, { recursive: true, force: true });
}
mkdirSync(join(PKG_DIR, "bin"), { recursive: true });
mkdirSync(join(PKG_DIR, "lib"), { recursive: true });
mkdirSync(join(PKG_DIR, "Resources", "app", "bun"), { recursive: true });
mkdirSync(join(PKG_DIR, "Resources", "app", "views", "mainview", "assets"), { recursive: true });
mkdirSync(ARTIFACTS_DIR, { recursive: true });

// 1. Build frontend if needed
console.log("[build-installer] 1. Compiling frontend UI bundle with Vite...");
execSync("vite build", { stdio: "inherit" });

// 2. Build backend bun bundle
console.log("[build-installer] 2. Bundling backend Bun process...");
const backendOut = join(PKG_DIR, "Resources", "app", "bun", "index.js");
execSync(`bun build src/bun/index.ts --target=bun --outfile="${backendOut}"`, { stdio: "inherit" });

// 3. Copy frontend views
console.log("[build-installer] 3. Copying webview assets...");
cpSync(join(DIST_DIR, "index.html"), join(PKG_DIR, "Resources", "app", "views", "mainview", "index.html"));
cpSync(join(DIST_DIR, "mini.html"), join(PKG_DIR, "Resources", "app", "views", "mainview", "mini.html"));
cpSync(join(DIST_DIR, "assets"), join(PKG_DIR, "Resources", "app", "views", "mainview", "assets"), { recursive: true });

// 4. Copy tray icons and metadata
cpSync(ICON_PATH, join(PKG_DIR, "Resources", "app", "views", "tray.ico"));
cpSync(TRAY_PNG_PATH, join(PKG_DIR, "Resources", "app", "views", "tray.png"));
cpSync(ICON_PATH, join(PKG_DIR, "Resources", "app.ico"));

// 5. Copy launcher runtime binaries and libraries
console.log("[build-installer] 4. Copying native launcher binaries and DLLs...");
const binFiles = [
	"launcher.exe",
	"bun.exe",
	"libNativeWrapper.dll",
	"WebView2Loader.dll",
	"libasar.dll",
	"libasar-arm64.dll",
	"bspatch.exe",
	"zig-zstd.exe",
];

for (const f of binFiles) {
	const src = join(DEV_BIN_DIR, f);
	if (existsSync(src)) {
		cpSync(src, join(PKG_DIR, "bin", f));
	}
}

// 6. Copy and configure Resources
if (existsSync(join(DEV_RES_DIR, "main.js"))) {
	cpSync(join(DEV_RES_DIR, "main.js"), join(PKG_DIR, "Resources", "main.js"));
}

const versionJson = {
	version: VERSION,
	hash: "stable",
	channel: "stable",
	baseUrl: "",
	name: "Lakky",
	identifier: "player.lak.app",
};
writeFileSync(join(PKG_DIR, "Resources", "version.json"), JSON.stringify(versionJson, null, 2), "utf-8");
writeFileSync(join(PKG_DIR, "Resources", "build.json"), JSON.stringify({ channel: "stable" }, null, 2), "utf-8");

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>launcher.exe</string>
	<key>CFBundleIdentifier</key>
	<string>player.lak.app</string>
	<key>CFBundleName</key>
	<string>Lakky</string>
	<key>CFBundleVersion</key>
	<string>${VERSION}</string>
	<key>CFBundleShortVersionString</key>
	<string>${VERSION}</string>
</dict>
</plist>`;
writeFileSync(join(PKG_DIR, "Info.plist"), infoPlist, "utf-8");

// 7. Embed icon into launcher.exe and bun.exe
console.log("[build-installer] 5. Embedding application icon into launcher.exe...");
const launcherPath = join(PKG_DIR, "bin", "launcher.exe");
const bunPath = join(PKG_DIR, "bin", "bun.exe");
try {
	await rcedit(launcherPath, { icon: ICON_PATH });
	if (existsSync(bunPath)) await rcedit(bunPath, { icon: ICON_PATH });
} catch (e) {
	console.warn("[build-installer] Warning embedding icon:", e);
}

// 8. Create portable release zip
console.log("[build-installer] 6. Creating portable release zip...");
const portableZip = join(ARTIFACTS_DIR, `Lakky-v${VERSION}-win-x64-portable.zip`);
if (existsSync(portableZip)) unlinkSync(portableZip);
execSync(`powershell -NoProfile -Command "Get-ChildItem -Path '${PKG_DIR}' | Compress-Archive -DestinationPath '${portableZip}' -Force"`);

// 9. Create payload zip for installer embedding
console.log("[build-installer] 7. Creating installer payload archive...");
const payloadZip = join(ROOT, "build", "payload.zip");
if (existsSync(payloadZip)) unlinkSync(payloadZip);
execSync(`powershell -NoProfile -Command "Get-ChildItem -Path '${PKG_DIR}' | Compress-Archive -DestinationPath '${payloadZip}' -Force"`);

// 10. Generate custom C# Windows Installer Source
console.log("[build-installer] 8. Generating C# Windows Installer source...");
const installerCs = `
using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LakkyInstaller
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool isSilent = false;
            foreach (string arg in args)
            {
                string a = arg.Trim().ToLowerInvariant();
                if (a == "/s" || a == "/silent" || a == "/verysilent" || a == "--silent")
                    isSilent = true;
            }

            if (isSilent)
            {
                SilentInstall();
            }
            else
            {
                Application.Run(new InstallerForm());
            }
        }

        public static void SilentInstall()
        {
            try
            {
                KillRunningLakky();
                string installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Lakky");
                ExtractPayload(installDir, null);
                CreateShortcuts(installDir, true, true);
                RegisterUninstaller(installDir);
            }
            catch (Exception ex)
            {
                try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "lakky_install_error.log"), ex.ToString()); } catch {}
            }
        }

        public static void KillRunningLakky()
        {
            try
            {
                foreach (var p in Process.GetProcessesByName("launcher"))
                {
                    try { p.Kill(); p.WaitForExit(1000); } catch {}
                }
                foreach (var p in Process.GetProcessesByName("bun"))
                {
                    try { p.Kill(); p.WaitForExit(1000); } catch {}
                }
                foreach (var p in Process.GetProcessesByName("lakky"))
                {
                    try { p.Kill(); p.WaitForExit(1000); } catch {}
                }
            }
            catch {}
        }

        public static void ExtractPayload(string targetDir, Action<int, string> progressCallback)
        {
            if (!Directory.Exists(targetDir))
                Directory.CreateDirectory(targetDir);

            var assembly = Assembly.GetExecutingAssembly();
            using (var stream = assembly.GetManifestResourceStream("payload.zip"))
            {
                if (stream == null)
                    throw new Exception("Installer corrupted: embedded payload.zip missing.");

                using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    int total = archive.Entries.Count;
                    int cur = 0;
                    foreach (var entry in archive.Entries)
                    {
                        cur++;
                        string rawPath = entry.FullName.Replace('/', Path.DirectorySeparatorChar).Replace('\\\\', Path.DirectorySeparatorChar);
                        string fullPath = Path.Combine(targetDir, rawPath);

                        if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\\\") || string.IsNullOrEmpty(entry.Name))
                        {
                            if (!Directory.Exists(fullPath))
                                Directory.CreateDirectory(fullPath);
                        }
                        else
                        {
                            string dir = Path.GetDirectoryName(fullPath);
                            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                                Directory.CreateDirectory(dir);

                            try
                            {
                                if (File.Exists(fullPath))
                                    File.Delete(fullPath);
                                entry.ExtractToFile(fullPath, true);
                            }
                            catch
                            {
                                entry.ExtractToFile(fullPath, true);
                            }
                        }

                        if (progressCallback != null && total > 0)
                        {
                            int pct = (int)((cur / (float)total) * 100);
                            progressCallback(pct, Path.GetFileName(rawPath));
                        }
                    }
                }
            }
        }

        public static void CreateShortcuts(string installDir, bool desktop, bool startMenu)
        {
            string exePath = Path.Combine(installDir, "bin", "launcher.exe");
            if (!File.Exists(exePath)) return;

            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            dynamic shell = Activator.CreateInstance(shellType);

            if (desktop)
            {
                string deskPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Lakky Player.lnk");
                dynamic sc = shell.CreateShortcut(deskPath);
                sc.TargetPath = exePath;
                sc.WorkingDirectory = Path.Combine(installDir, "bin");
                sc.IconLocation = exePath + ",0";
                sc.Description = "Lakky Player — Modern Anime Cel-Shaded Media Station";
                sc.Save();
            }

            if (startMenu)
            {
                string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                string lakkyStartDir = Path.Combine(programs, "Lakky");
                if (!Directory.Exists(lakkyStartDir)) Directory.CreateDirectory(lakkyStartDir);

                string lnkPath = Path.Combine(lakkyStartDir, "Lakky Player.lnk");
                dynamic sc = shell.CreateShortcut(lnkPath);
                sc.TargetPath = exePath;
                sc.WorkingDirectory = Path.Combine(installDir, "bin");
                sc.IconLocation = exePath + ",0";
                sc.Description = "Lakky Player";
                sc.Save();
            }
        }

        public static void RegisterUninstaller(string installDir)
        {
            try
            {
                string uninstallerCmd = Path.Combine(installDir, "uninstall.cmd");
                File.WriteAllText(uninstallerCmd, 
                    "@echo off\\r\\n" +
                    "taskkill /F /IM launcher.exe 2>nul\\r\\n" +
                    "taskkill /F /IM bun.exe 2>nul\\r\\n" +
                    "echo Removing Lakky Player...\\r\\n" +
                    "timeout /t 1 /nobreak >nul\\r\\n" +
                    "rd /s /q \\"" + installDir + "\\"\\r\\n" +
                    "del \\"" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Lakky Player.lnk") + "\\" 2>nul\\r\\n" +
                    "rd /s /q \\"" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Lakky") + "\\" 2>nul\\r\\n" +
                    "reg delete \\"HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Lakky\\" /f 2>nul\\r\\n" +
                    "echo Lakky has been removed successfully.\\r\\n"
                );

                using (var key = Registry.CurrentUser.CreateSubKey(@"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Lakky"))
                {
                    if (key != null)
                    {
                        key.SetValue("DisplayName", "Lakky Player");
                        key.SetValue("DisplayVersion", "${VERSION}");
                        key.SetValue("Publisher", "Laknicek");
                        key.SetValue("InstallLocation", installDir);
                        key.SetValue("DisplayIcon", Path.Combine(installDir, "bin", "launcher.exe") + ",0");
                        key.SetValue("UninstallString", "cmd.exe /c \\"" + uninstallerCmd + "\\"");
                        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                        key.SetValue("EstimatedSize", 125000, RegistryValueKind.DWord);
                    }
                }
            }
            catch {}
        }
    }

    public class InstallerForm : Form
    {
        private Panel headerPanel;
        private Label titleLabel;
        private Label subTitleLabel;
        private Label destLabel;
        private TextBox pathTextBox;
        private Button browseButton;
        private CheckBox desktopCheck;
        private CheckBox startMenuCheck;
        private CheckBox launchCheck;
        private ProgressBar progressBar;
        private Label statusLabel;
        private Button installButton;
        private Button cancelButton;
        private bool isInstalling = false;

        public InstallerForm()
        {
            InitializeComponent();
        }

        private void InitializeComponent()
        {
            this.Text = "Lakky Player Setup";
            this.Size = new Size(540, 410);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = true;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(18, 16, 28);
            this.ForeColor = Color.FromArgb(235, 235, 245);
            this.Font = new Font("Segoe UI", 9F, FontStyle.Regular);

            headerPanel = new Panel()
            {
                Dock = DockStyle.Top,
                Height = 85,
                BackColor = Color.FromArgb(28, 22, 45)
            };
            headerPanel.Paint += HeaderPanel_Paint;

            titleLabel = new Label()
            {
                Text = "🌸 Lakky Player v${VERSION}",
                Font = new Font("Segoe UI", 15F, FontStyle.Bold),
                ForeColor = Color.FromArgb(245, 180, 220),
                Location = new Point(22, 14),
                AutoSize = true
            };

            subTitleLabel = new Label()
            {
                Text = "2026 Anime Cel-Shaded 3D Media Station & DSP Workstation",
                Font = new Font("Segoe UI", 8.5F, FontStyle.Regular),
                ForeColor = Color.FromArgb(170, 165, 195),
                Location = new Point(24, 48),
                AutoSize = true
            };

            headerPanel.Controls.Add(titleLabel);
            headerPanel.Controls.Add(subTitleLabel);
            this.Controls.Add(headerPanel);

            destLabel = new Label()
            {
                Text = "Installation Folder:",
                Location = new Point(24, 102),
                AutoSize = true,
                ForeColor = Color.FromArgb(200, 200, 220)
            };
            this.Controls.Add(destLabel);

            string defaultPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Lakky");
            pathTextBox = new TextBox()
            {
                Text = defaultPath,
                Location = new Point(26, 124),
                Size = new Size(380, 25),
                BackColor = Color.FromArgb(26, 22, 40),
                ForeColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle
            };
            this.Controls.Add(pathTextBox);

            browseButton = new Button()
            {
                Text = "Browse...",
                Location = new Point(416, 122),
                Size = new Size(86, 27),
                BackColor = Color.FromArgb(42, 34, 65),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            browseButton.FlatAppearance.BorderColor = Color.FromArgb(80, 65, 120);
            browseButton.Click += (s, e) => {
                using (var fbd = new FolderBrowserDialog())
                {
                    fbd.SelectedPath = pathTextBox.Text;
                    if (fbd.ShowDialog() == DialogResult.OK)
                        pathTextBox.Text = fbd.SelectedPath;
                }
            };
            this.Controls.Add(browseButton);

            desktopCheck = new CheckBox()
            {
                Text = "Create Desktop shortcut",
                Checked = true,
                Location = new Point(26, 165),
                AutoSize = true,
                ForeColor = Color.FromArgb(220, 220, 235)
            };
            this.Controls.Add(desktopCheck);

            startMenuCheck = new CheckBox()
            {
                Text = "Create Start Menu shortcut",
                Checked = true,
                Location = new Point(26, 192),
                AutoSize = true,
                ForeColor = Color.FromArgb(220, 220, 235)
            };
            this.Controls.Add(startMenuCheck);

            launchCheck = new CheckBox()
            {
                Text = "Launch Lakky Player after installation",
                Checked = true,
                Location = new Point(26, 219),
                AutoSize = true,
                ForeColor = Color.FromArgb(220, 220, 235)
            };
            this.Controls.Add(launchCheck);

            statusLabel = new Label()
            {
                Text = "Ready to install.",
                Location = new Point(24, 256),
                Size = new Size(475, 20),
                ForeColor = Color.FromArgb(160, 155, 185)
            };
            this.Controls.Add(statusLabel);

            progressBar = new ProgressBar()
            {
                Location = new Point(26, 278),
                Size = new Size(476, 18),
                Minimum = 0,
                Maximum = 100,
                Value = 0,
                Visible = true
            };
            this.Controls.Add(progressBar);

            installButton = new Button()
            {
                Text = "Install Lakky",
                Font = new Font("Segoe UI", 9.5F, FontStyle.Bold),
                Location = new Point(275, 320),
                Size = new Size(130, 36),
                BackColor = Color.FromArgb(167, 139, 250),
                ForeColor = Color.FromArgb(15, 12, 28),
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand
            };
            installButton.FlatAppearance.BorderSize = 0;
            installButton.Click += InstallButton_Click;
            this.Controls.Add(installButton);

            cancelButton = new Button()
            {
                Text = "Cancel",
                Location = new Point(415, 320),
                Size = new Size(88, 36),
                BackColor = Color.FromArgb(36, 30, 52),
                ForeColor = Color.FromArgb(200, 200, 220),
                FlatStyle = FlatStyle.Flat
            };
            cancelButton.FlatAppearance.BorderColor = Color.FromArgb(65, 55, 90);
            cancelButton.Click += (s, e) => this.Close();
            this.Controls.Add(cancelButton);
        }

        private void HeaderPanel_Paint(object sender, PaintEventArgs e)
        {
            using (var brush = new LinearGradientBrush(headerPanel.ClientRectangle, 
                Color.FromArgb(42, 28, 75), Color.FromArgb(20, 16, 32), LinearGradientMode.Horizontal))
            {
                e.Graphics.FillRectangle(brush, headerPanel.ClientRectangle);
            }
            using (var pen = new Pen(Color.FromArgb(90, 70, 140), 1))
            {
                e.Graphics.DrawLine(pen, 0, headerPanel.Height - 1, headerPanel.Width, headerPanel.Height - 1);
            }
        }

        private async void InstallButton_Click(object sender, EventArgs e)
        {
            if (isInstalling) return;
            isInstalling = true;

            string targetDir = pathTextBox.Text.Trim();
            if (string.IsNullOrEmpty(targetDir))
            {
                MessageBox.Show("Please select a valid installation folder.", "Error", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                isInstalling = false;
                return;
            }

            installButton.Enabled = false;
            browseButton.Enabled = false;
            pathTextBox.Enabled = false;
            desktopCheck.Enabled = false;
            startMenuCheck.Enabled = false;
            cancelButton.Enabled = false;

            statusLabel.Text = "Stopping any running Lakky instances...";
            progressBar.Value = 10;

            await System.Threading.Tasks.Task.Run(() =>
            {
                Program.KillRunningLakky();
            });

            statusLabel.Text = "Extracting media player files...";
            progressBar.Value = 25;

            bool success = false;
            string errorMsg = "";

            await System.Threading.Tasks.Task.Run(() =>
            {
                try
                {
                    Program.ExtractPayload(targetDir, (pct, file) =>
                    {
                        this.Invoke(new Action(() =>
                        {
                            int val = 25 + (int)(pct * 0.55f);
                            if (val <= 80) progressBar.Value = val;
                            statusLabel.Text = "Extracting: " + file;
                        }));
                    });

                    this.Invoke(new Action(() => {
                        statusLabel.Text = "Creating shortcuts...";
                        progressBar.Value = 85;
                    }));

                    Program.CreateShortcuts(targetDir, desktopCheck.Checked, startMenuCheck.Checked);

                    this.Invoke(new Action(() => {
                        statusLabel.Text = "Registering Windows uninstaller...";
                        progressBar.Value = 95;
                    }));

                    Program.RegisterUninstaller(targetDir);

                    success = true;
                }
                catch (Exception ex)
                {
                    errorMsg = ex.Message;
                }
            });

            progressBar.Value = 100;

            if (success)
            {
                statusLabel.Text = "✓ Installation complete!";
                statusLabel.ForeColor = Color.FromArgb(130, 240, 160);

                if (launchCheck.Checked)
                {
                    string exePath = Path.Combine(targetDir, "bin", "launcher.exe");
                    if (File.Exists(exePath))
                    {
                        Process.Start(new ProcessStartInfo()
                        {
                            FileName = exePath,
                            WorkingDirectory = Path.Combine(targetDir, "bin"),
                            UseShellExecute = true
                        });
                    }
                }

                MessageBox.Show("Lakky Player v${VERSION} was installed successfully!", "Installation Finished", MessageBoxButtons.OK, MessageBoxIcon.Information);
                this.Close();
            }
            else
            {
                statusLabel.Text = "Installation failed.";
                statusLabel.ForeColor = Color.FromArgb(250, 120, 120);
                MessageBox.Show("Failed to install Lakky:\\n" + errorMsg, "Installation Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                installButton.Enabled = true;
                cancelButton.Enabled = true;
                isInstalling = false;
            }
        }
    }
}
`;

const csFile = join(ROOT, "build", "Installer.cs");
writeFileSync(csFile, installerCs.trim(), "utf-8");

// 11. Compile C# standalone installer
console.log("[build-installer] 9. Compiling standalone Windows Installer with native csc.exe...");
const outExe = join(ARTIFACTS_DIR, "Lakky-Setup.exe");
const namedExe = join(ARTIFACTS_DIR, `Lakky-v${VERSION}-Setup.exe`);
const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

const cmd = `"${cscPath}" /target:winexe /win32icon:"${ICON_PATH}" /resource:"${payloadZip}",payload.zip /out:"${outExe}" /platform:x64 /optimize+ /reference:System.IO.Compression.dll,System.IO.Compression.FileSystem.dll,Microsoft.CSharp.dll,System.Drawing.dll,System.Windows.Forms.dll "${csFile}"`;

execSync(cmd, { stdio: "inherit" });
cpSync(outExe, namedExe, { force: true });

console.log(`[build-installer] ✓ Setup built successfully: ${outExe}`);
console.log(`[build-installer] ✓ Setup named copy: ${namedExe}`);
console.log(`[build-installer] ✓ Portable zip: ${portableZip}`);
