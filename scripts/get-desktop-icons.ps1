# Output JSON: [{"name":"...","path":"...","x":N,"y":N}, ...]
# Coordinates are physical pixels relative to screen top-left; main process does DPI conversion.
#
# Names are read directly from the desktop ListView via LVM_GETITEMTEXTW,
# in the SAME display order as the positions returned by LVM_GETITEMPOSITION.
# This avoids the historical bug where positions[i] (ListView order) was paired
# with shellItems[i] (Shell.Namespace canonical order), which desyncs whenever
# the user's desktop view order differs from the Shell's canonical order.
# Paths are resolved by matching the displayed name to <name>.lnk on disk.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class DesktopIcons {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowW(string className, string windowName);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr childAfter, string className, string windowName);
  [DllImport("user32.dll")]
  public static extern int GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("kernel32.dll")]
  public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
  [DllImport("kernel32.dll")]
  public static extern IntPtr VirtualAllocEx(IntPtr hProcess, IntPtr lpAddress, uint dwSize, uint flAllocationType, uint flProtect);
  [DllImport("kernel32.dll")]
  public static extern bool VirtualFreeEx(IntPtr hProcess, IntPtr lpAddress, uint dwSize, uint dwFreeType);
  [DllImport("kernel32.dll")]
  public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, uint nSize, out uint lpNumberOfBytesRead);
  [DllImport("kernel32.dll")]
  public static extern bool WriteProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, uint nSize, out uint lpNumberOfBytesWritten);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr hObject);
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

  public const uint LVM_FIRST              = 0x1000;
  public const uint LVM_GETITEMCOUNT       = LVM_FIRST + 4;
  public const uint LVM_GETITEMPOSITION    = LVM_FIRST + 16;
  public const uint LVM_GETITEMTEXTW       = LVM_FIRST + 115;
  public const uint PROCESS_VM_OPERATION   = 0x0008;
  public const uint PROCESS_VM_READ        = 0x0010;
  public const uint PROCESS_VM_WRITE       = 0x0020;
  public const uint PROCESS_QUERY_INFORMATION = 0x0400;
  public const uint MEM_COMMIT  = 0x1000;
  public const uint MEM_RESERVE = 0x2000;
  public const uint MEM_RELEASE = 0x8000;
  public const uint PAGE_READWRITE = 0x04;
  public const uint LVIF_TEXT = 1;

  // Progman/WorkerW -> SHELLDLL_DefView -> SysListView32
  public static IntPtr FindDesktopListView() {
    IntPtr prog = FindWindowW("Progman", null);
    IntPtr def = IntPtr.Zero;
    if (prog != IntPtr.Zero)
      def = FindWindowExW(prog, IntPtr.Zero, "SHELLDLL_DefView", null);

    IntPtr w = IntPtr.Zero;
    while (def == IntPtr.Zero && (w = FindWindowExW(IntPtr.Zero, w, "WorkerW", null)) != IntPtr.Zero) {
      def = FindWindowExW(w, IntPtr.Zero, "SHELLDLL_DefView", null);
    }
    if (def == IntPtr.Zero) return IntPtr.Zero;
    return FindWindowExW(def, IntPtr.Zero, "SysListView32", null);
  }

  // Returns flat list: name0, x0, y0, name1, x1, y1, ...
  // Names come from LVM_GETITEMTEXTW (display order == position order, guaranteed in sync).
  public static List<object> GetItems(IntPtr hList) {
    var result = new List<object>();
    int count = (int)SendMessageW(hList, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero);
    if (count <= 0) return result;

    uint pid;
    GetWindowThreadProcessId(hList, out pid);
    IntPtr hProc = OpenProcess(
      PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION,
      false, pid);
    if (hProc == IntPtr.Zero) return result;

    // 64-bit LVITEMW is 88 bytes (pointers 8B, aligned); 32-bit is 60 bytes.
    bool is64 = IntPtr.Size == 8;
    int lviSize   = is64 ? 88 : 60;
    int pszOffset = is64 ? 24 : 20;  // offset of pszText pointer
    int cchOffset = is64 ? 32 : 24;  // offset of cchTextMax
    int textBytes = 520;             // 260 wchars * 2 bytes

    IntPtr posBuf  = VirtualAllocEx(hProc, IntPtr.Zero, 16,          MEM_COMMIT|MEM_RESERVE, PAGE_READWRITE);
    IntPtr lviBuf  = VirtualAllocEx(hProc, IntPtr.Zero, (uint)lviSize, MEM_COMMIT|MEM_RESERVE, PAGE_READWRITE);
    IntPtr textBuf = VirtualAllocEx(hProc, IntPtr.Zero, (uint)textBytes, MEM_COMMIT|MEM_RESERVE, PAGE_READWRITE);

    if (posBuf == IntPtr.Zero || lviBuf == IntPtr.Zero || textBuf == IntPtr.Zero) {
      if (posBuf  != IntPtr.Zero) VirtualFreeEx(hProc, posBuf,  0, MEM_RELEASE);
      if (lviBuf  != IntPtr.Zero) VirtualFreeEx(hProc, lviBuf,  0, MEM_RELEASE);
      if (textBuf != IntPtr.Zero) VirtualFreeEx(hProc, textBuf, 0, MEM_RELEASE);
      CloseHandle(hProc);
      return result;
    }

    long textBufAddr = textBuf.ToInt64();

    for (int i = 0; i < count; i++) {
      // --- position ---
      SendMessageW(hList, LVM_GETITEMPOSITION, (IntPtr)i, posBuf);
      byte[] posTmp = new byte[8];
      uint read;
      ReadProcessMemory(hProc, posBuf, posTmp, 8, out read);
      int px = BitConverter.ToInt32(posTmp, 0);
      int py = BitConverter.ToInt32(posTmp, 4);

      // --- name via LVM_GETITEMTEXTW ---
      byte[] lvi = new byte[lviSize];
      BitConverter.GetBytes((uint)LVIF_TEXT).CopyTo(lvi, 0);   // mask
      BitConverter.GetBytes(i).CopyTo(lvi, 4);                 // iItem (ignored by msg but harmless)
      BitConverter.GetBytes(0).CopyTo(lvi, 8);                 // iSubItem = 0 (item label)
      BitConverter.GetBytes(textBufAddr).CopyTo(lvi, pszOffset); // pszText -> remote text buffer
      BitConverter.GetBytes(260).CopyTo(lvi, cchOffset);       // cchTextMax

      uint written;
      WriteProcessMemory(hProc, lviBuf, lvi, (uint)lviSize, out written);

      SendMessageW(hList, LVM_GETITEMTEXTW, (IntPtr)i, lviBuf);

      byte[] textRaw = new byte[textBytes];
      ReadProcessMemory(hProc, textBuf, textRaw, (uint)textBytes, out read);

      // UTF-16LE decode, stop at first NUL char
      var sb = new StringBuilder();
      int charCount = textRaw.Length / 2;
      for (int j = 0; j < charCount; j++) {
        char c = (char)(textRaw[j*2] | (textRaw[j*2 + 1] << 8));
        if (c == 0) break;
        sb.Append(c);
      }

      result.Add(sb.ToString());
      result.Add(px);
      result.Add(py);
    }

    VirtualFreeEx(hProc, posBuf,  0, MEM_RELEASE);
    VirtualFreeEx(hProc, lviBuf,  0, MEM_RELEASE);
    VirtualFreeEx(hProc, textBuf, 0, MEM_RELEASE);
    CloseHandle(hProc);
    return result;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

$hList = [DesktopIcons]::FindDesktopListView()
if ($hList -eq [IntPtr]::Zero) {
  Write-Error "Cannot find desktop SysListView32"
  exit 1
}

$flat = [DesktopIcons]::GetItems($hList)

# Resolve path: match the displayed name to <name>.lnk on the desktop filesystem.
function Build-LnkMap {
  $map = @{}
  $dirs = @()
  if ($env:USERPROFILE) { $dirs += (Join-Path $env:USERPROFILE 'Desktop') }
  if ($env:PUBLIC)       { $dirs += (Join-Path $env:PUBLIC 'Desktop') }
  foreach ($d in $dirs) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    Get-ChildItem -LiteralPath $d -Filter '*.lnk' -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
      if (-not $map.ContainsKey($_.BaseName)) { $map[$_.BaseName] = $_.FullName }
    }
  }
  return $map
}
$lnkMap = Build-LnkMap

$items = @()
for ($i = 0; $i -lt $flat.Count; $i += 3) {
  $name = [string]$flat[$i]
  $x    = [int]$flat[$i+1]
  $y    = [int]$flat[$i+2]
  if ([string]::IsNullOrEmpty($name)) { continue }
  $path = $null
  if ($lnkMap.ContainsKey($name)) { $path = $lnkMap[$name] }
  $items += [PSCustomObject]@{
    name = $name
    path = $path
    x    = $x
    y    = $y
  }
}

if ($items.Count -eq 0) {
  Write-Output "[]"
} elseif ($items.Count -eq 1) {
  Write-Output ("[" + ($items[0] | ConvertTo-Json -Compress -Depth 2) + "]")
} else {
  $items | ConvertTo-Json -Compress -Depth 2
}
