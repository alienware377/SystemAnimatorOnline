# XR Animator Multi-Camera 3D - installer / uninstaller
#
# Patches an existing XR Animator (desktop app) folder:
#  - copies js\multicam\*.js
#  - adds one hook line to js\SA_system_emulation.min.js
#  - adds 3 script tags to SystemAnimator_webkit.html and XR_Animator.html
# Originals are backed up next to each file as *.multicam-backup.
#
# Usage: install.bat            (install)
#        install.bat -Uninstall (restore the backups)

param(
  [string]$Path = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding($false)

$HOOK_ANCHOR = 'return function(e){var ye=typeof e.data=="string"&&e.data.charAt(0)==="{"?JSON.parse(e.data):e.data;'
$HOOK_CODE = 'if(window.MC_multicam&&ye&&typeof ye==="object")ye=MC_multicam.process(ye)||ye;'
$TAG_ANCHOR = '<script type="text/javascript" language="javascript" src="js/core_extra.js"></script>'
$TAGS = @(
  '<script src="js/multicam/mc_geometry.js"></script>',
  '<script src="js/multicam/mc_fuse.js"></script>',
  '<script src="js/multicam/mc_main.js"></script>'
)
$PAGES = @('SystemAnimator_webkit.html', 'XR_Animator.html')
$MIN_REL = 'js\SA_system_emulation.min.js'

function Find-XRA([string]$start) {
  if (-not $start -or -not (Test-Path $start)) { return $null }
  if (Test-Path (Join-Path $start $MIN_REL)) { return (Resolve-Path $start).Path }
  $hit = Get-ChildItem -Path $start -Filter 'SA_system_emulation.min.js' -Recurse -Depth 6 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { return (Split-Path -Parent (Split-Path -Parent $hit.FullName)) }
  return $null
}

function Pick-Folder {
  Add-Type -AssemblyName System.Windows.Forms
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = 'Choose your XR Animator folder (the one you unzipped)'
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.SelectedPath }
  return $null
}

# 1. find XR Animator
$root = $null
if ($Path) { $root = Find-XRA $Path }
if (-not $root) {
  foreach ($c in @((Split-Path -Parent $here), $here, "$env:USERPROFILE\Desktop", "$env:USERPROFILE\Downloads", "$env:USERPROFILE\Documents")) {
    $root = Find-XRA $c
    if ($root) { break }
  }
}
if (-not $root) {
  Write-Host "Could not find XR Animator automatically. Please choose its folder."
  $picked = Pick-Folder
  if ($picked) { $root = Find-XRA $picked }
}
if (-not $root) { Write-Host "XR Animator folder not found. Nothing changed."; exit 1 }
Write-Host "XR Animator found at: $root"

$minPath = Join-Path $root $MIN_REL

# 2. uninstall
if ($Uninstall) {
  foreach ($f in @($MIN_REL) + $PAGES) {
    $p = Join-Path $root $f
    if (Test-Path "$p.multicam-backup") {
      Copy-Item "$p.multicam-backup" $p -Force
      Remove-Item "$p.multicam-backup" -Force
      Write-Host "restored $f"
    }
  }
  $mc = Join-Path $root 'js\multicam'
  if (Test-Path $mc) { Remove-Item $mc -Recurse -Force; Write-Host "removed js\multicam" }
  Write-Host "Uninstalled."
  exit 0
}

# 3. check the hook point before touching anything
$minText = [System.IO.File]::ReadAllText($minPath, $utf8)
$hooked = $minText.Contains($HOOK_CODE)
if (-not $hooked) {
  $count = ([regex]::Matches($minText, [regex]::Escape($HOOK_ANCHOR))).Count
  if ($count -ne 1) {
    Write-Host "This XR Animator version is different from the one this patch was made for (hook point found $count times)."
    Write-Host "Nothing changed. Please ask for an updated patch."
    exit 1
  }
}

# 4. copy files
$dst = Join-Path $root 'js\multicam'
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item (Join-Path $here 'files\js\multicam\*.js') $dst -Force
Write-Host "copied js\multicam"

# 5. hook
if (-not $hooked) {
  if (-not (Test-Path "$minPath.multicam-backup")) { Copy-Item $minPath "$minPath.multicam-backup" }
  $minText = $minText.Replace($HOOK_ANCHOR, $HOOK_ANCHOR + $HOOK_CODE)
  [System.IO.File]::WriteAllText($minPath, $minText, $utf8)
  Write-Host "hooked $MIN_REL"
} else {
  Write-Host "$MIN_REL already hooked"
}

# 6. script tags
foreach ($page in $PAGES) {
  $p = Join-Path $root $page
  if (-not (Test-Path $p)) { continue }
  $html = [System.IO.File]::ReadAllText($p, $utf8)
  if ($html.Contains('js/multicam/mc_main.js')) { Write-Host "$page already patched"; continue }
  if (-not $html.Contains($TAG_ANCHOR)) { Write-Host "WARNING: $page has an unexpected layout, skipped"; continue }
  $eol = "`n"
  if ($html.Contains("`r`n")) { $eol = "`r`n" }
  if (-not (Test-Path "$p.multicam-backup")) { Copy-Item $p "$p.multicam-backup" }
  $html = $html.Replace($TAG_ANCHOR, $TAG_ANCHOR + $eol + ($TAGS -join $eol))
  [System.IO.File]::WriteAllText($p, $html, $utf8)
  Write-Host "patched $page"
}

Write-Host ""
Write-Host "Done. Start XR Animator, start its camera, then press Ctrl+Shift+M (or click the small 3D button)."
