import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const BUILD_DIR = join(ROOT, "build", "stable-win-x64");
const LAKKY_DIR = join(BUILD_DIR, "Lakky");
const ARTIFACTS_DIR = join(ROOT, "artifacts");
const ICON_PATH = join(ROOT, "assets", "icon.ico");
const VERSION = "1.1.0";

if (!existsSync(LAKKY_DIR)) {
	console.error(`[installer] Error: ${LAKKY_DIR} does not exist. Run "bun run build" first.`);
	process.exit(1);
}

if (!existsSync(ARTIFACTS_DIR)) {
	mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

console.log("[installer] 1. Packing Lakky distribution into zip payload...");
const payloadZip = join(ROOT, "build", "payload.zip");
if (existsSync(payloadZip)) unlinkSync(payloadZip);

execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${LAKKY_DIR}\\*' -DestinationPath '${payloadZip}' -Force"`, {
	stdio: "inherit",
});

console.log("[installer] 2. Generating custom C# Windows 10/11 Installer source...");

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
                        string fullPath = Path.Combine(targetDir, entry.FullName);
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(fullPath);
                        }
                        else
                        {
                            string dir = Path.GetDirectoryName(fullPath);
                            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                                Directory.CreateDirectory(dir);

                            entry.ExtractToFile(fullPath, true);
                        }

                        if (progressCallback != null && total > 0)
                        {
                            int pct = (int)((cur / (float)total) * 100);
                            progressCallback(pct, entry.Name);
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
                        key.SetValue("EstimatedSize", 35000, RegistryValueKind.DWord);
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
                            WorkingDirectory = Path.Combine(targetDir, "bin")
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

console.log("[installer] 3. Compiling standalone Windows Installer EXE using native csc.exe...");
const outExe = join(ARTIFACTS_DIR, "Lakky-Setup.exe");
const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

const cmd = `"${cscPath}" /target:winexe /win32icon:"${ICON_PATH}" /resource:"${payloadZip}",payload.zip /out:"${outExe}" /platform:x64 /optimize+ /reference:System.IO.Compression.dll,System.IO.Compression.FileSystem.dll,Microsoft.CSharp.dll,System.Drawing.dll,System.Windows.Forms.dll "${csFile}"`;

try {
	execSync(cmd, { stdio: "inherit" });
	console.log(`[installer] ✓ Success: Single standalone setup created at: ${outExe}`);
	// Also copy as Lakky-v1.1.0-Setup.exe for release clarity
	const namedExe = join(ARTIFACTS_DIR, `Lakky-v${VERSION}-Setup.exe`);
	execSync(`powershell -NoProfile -Command "Copy-Item '${outExe}' '${namedExe}' -Force"`);
	console.log(`[installer] ✓ Copied as: ${namedExe}`);
} catch (err) {
	console.error("[installer] Compilation error:", err);
	process.exit(1);
}
