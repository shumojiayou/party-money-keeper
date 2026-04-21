param(
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl,

    [string]$CommitMessage = "Initial cloud-ready party money keeper"
)

$ErrorActionPreference = "Stop"

$userName = git config user.name
$userEmail = git config user.email

if (-not $userName -or -not $userEmail) {
    throw "请先配置 git user.name 和 git user.email。"
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

git add .

try {
    git commit -m $CommitMessage
} catch {
    Write-Host "没有新的可提交内容，继续检查远程配置。"
}

$existingOrigin = ""
try {
    $existingOrigin = git remote get-url origin 2>$null
} catch {
    $existingOrigin = ""
}

if (-not $existingOrigin) {
    git remote add origin $RepoUrl
} elseif ($existingOrigin -ne $RepoUrl) {
    git remote set-url origin $RepoUrl
}

git push -u origin main
