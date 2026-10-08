# XR Animator Multi-Camera 3D - installer / uninstaller
#
# Patches an existing XR Animator (desktop app) folder:
#  - copies js\multicam\*.js
#  - adds small hooks to a few of XR Animator's own files (listed in patches.json)
# Originals are backed up next to each file as *.multicam-backup.
# Running it again (for example with a newer version of this add-on) re-applies
# everything cleanly from those backups.
#
# Usage: install.bat            (install or update)
#        install.bat -Uninstall (restore the originals)

param(
  [string]$Path = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding($false)
$MARKER_FILE = 'js\SA_system_emulation.min.js'

function Find-XRA([string]$start) {
  if (-not $start -or -not (Test-Path $start)) { return $null }
  if (Test-Path (Join-Path $start $MARKER_FILE)) { return (Resolve-Path $start).Path }
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

$patches = [System.IO.File]::ReadAllText((Join-Path $here 'patches.json'), $utf8) | ConvertFrom-Json
$files = @($patches | ForEach-Object { $_.file } | Select-Object -Unique)

# 2. uninstall
if ($Uninstall) {
  foreach ($f in $files) {
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

# 3. work out every patched file in memory first; touch nothing if anything is off
$result = @{}
foreach ($f in $files) {
  $p = Join-Path $root $f
  if (-not (Test-Path $p)) {
    $req = @($patches | Where-Object { $_.file -eq $f -and -not $_.optional })
    if ($req.Count -gt 0) { Write-Host "Missing file: $f. Nothing changed."; exit 1 }
    continue
  }
  $src = $p
  if (Test-Path "$p.multicam-backup") { $src = "$p.multicam-backup" }
  $text = [System.IO.File]::ReadAllText($src, $utf8)
  if ($src -eq $p -and $text.Contains('MC_multicam')) {
    Write-Host "$f was already patched but its backup is missing. Reinstall XR Animator's original files, then run this again."
    exit 1
  }
  $eol = "`n"
  if ($text.Contains("`r`n")) { $eol = "`r`n" }
  foreach ($pt in @($patches | Where-Object { $_.file -eq $f })) {
    $anchor = $pt.anchor.Replace("`n", $eol)
    $insert = $pt.insert.Replace("`n", $eol)
    $count = ([regex]::Matches($text, [regex]::Escape($anchor))).Count
    if ($count -ne 1) {
      if ($pt.optional) { Write-Host "skipped $($pt.what) in $f (not needed)"; continue }
      Write-Host "This XR Animator version is different from the one this add-on was made for ($($pt.what) in $f found $count times)."
      Write-Host "Nothing changed. Please ask for an updated version."
      exit 1
    }
    if ($pt.where -eq 'after') { $text = $text.Replace($anchor, $anchor + $insert) }
    else { $text = $text.Replace($anchor, $insert + $anchor) }
  }
  $result[$f] = $text
}

# 4. copy files
$dst = Join-Path $root 'js\multicam'
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item (Join-Path $here 'files\js\multicam\*.js') $dst -Force
Write-Host "copied js\multicam"

# 5. write the patched files
foreach ($f in $result.Keys) {
  $p = Join-Path $root $f
  if (-not (Test-Path "$p.multicam-backup")) { Copy-Item $p "$p.multicam-backup" }
  [System.IO.File]::WriteAllText($p, $result[$f], $utf8)
  Write-Host "patched $f"
}

Write-Host ""
Write-Host "Done. Start XR Animator, start its camera, then press Ctrl+Shift+M (3D panel) or Ctrl+Shift+L (live view)."
