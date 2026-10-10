# Security Check-in System - dependency-free static server (HttpListener)
$ErrorActionPreference = 'Stop'
$port = 8765
$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.gif'  = 'image/gif'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.map'  = 'application/json; charset=utf-8'
  '.woff' = 'font/woff'
  '.woff2'= 'font/woff2'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try {
  $listener.Start()
} catch {
  Write-Host ("Failed to listen on port " + $port + ". It may be in use.") -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "   Security Check-in System is running" -ForegroundColor Cyan
Write-Host ("   URL: http://localhost:" + $port) -ForegroundColor Yellow
Write-Host "   Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
      $raw = $ctx.Request.Url.AbsolutePath
      $rel = [Uri]::UnescapeDataString($raw).TrimStart('/')
      if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }

      $file = Join-Path $root ($rel -replace '/', '\')
      $fullRoot = (Resolve-Path $root).Path
      $fullFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($file)
      if ((-not $fullFile.StartsWith($fullRoot)) -or (-not (Test-Path -LiteralPath $fullFile -PathType Leaf))) {
        $ctx.Response.StatusCode = 404
        $bytes = [Text.Encoding]::UTF8.GetBytes('404 Not Found')
      } else {
        $ext = [IO.Path]::GetExtension($fullFile).ToLower()
        if ($mime.ContainsKey($ext)) { $ctx.Response.ContentType = $mime[$ext] }
        else { $ctx.Response.ContentType = 'application/octet-stream' }
        $bytes = [IO.File]::ReadAllBytes($fullFile)
        $ctx.Response.StatusCode = 200
      }
      $ctx.Response.AddHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      try { $ctx.Response.StatusCode = 500 } catch {}
    } finally {
      $ctx.Response.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
