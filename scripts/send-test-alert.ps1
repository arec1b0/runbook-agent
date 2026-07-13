<#
.SYNOPSIS
    Sends a test Alertmanager webhook payload to the local runbook-agent.

.DESCRIPTION
    Posts a realistic Alertmanager v4 payload to the webhook endpoint,
    then polls the health endpoint to confirm the incident was recorded.
    Use -AlertName and -Severity to exercise different runbook matchers.

.EXAMPLE
    .\scripts\send-test-alert.ps1
    Sends the default OOMKilled/critical alert.

.EXAMPLE
    .\scripts\send-test-alert.ps1 -AlertName HighRequestLatency -Severity critical
    Exercises the high-load-scale-up runbook.
#>
[CmdletBinding()]
param(
    [string]$AgentUrl = "http://localhost:3000",
    [string]$AlertName = "OOMKilled",
    [ValidateSet("critical", "warning", "info")]
    [string]$Severity = "critical",
    [string]$Service = "checkout-api",
    [string]$Namespace = "prod"
)

$ErrorActionPreference = "Stop"

$payload = @{
    version  = "4"
    groupKey = "{}:{alertname=`"$AlertName`"}"
    status   = "firing"
    receiver = "runbook-agent"
    alerts   = @(
        @{
            status      = "firing"
            labels      = @{
                alertname = $AlertName
                severity  = $Severity
                service   = $Service
                namespace = $Namespace
            }
            annotations = @{
                summary = "Test alert $AlertName for $Service"
            }
            startsAt    = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        }
    )
} | ConvertTo-Json -Depth 5

Write-Host "Sending $AlertName ($Severity) for $Namespace/$Service to $AgentUrl ..." -ForegroundColor Cyan

$response = Invoke-RestMethod `
    -Uri "$AgentUrl/webhook/alertmanager" `
    -Method Post `
    -ContentType "application/json" `
    -Body $payload

Write-Host "Webhook accepted: $($response | ConvertTo-Json -Compress)" -ForegroundColor Green

# Give the async pipeline a moment, then show system state.
Start-Sleep -Seconds 2

$health = Invoke-RestMethod -Uri "$AgentUrl/healthz" -Method Get
Write-Host "Health: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green

$approvals = Invoke-RestMethod -Uri "$AgentUrl/approvals" -Method Get
if ($approvals.pending.Count -gt 0) {
    Write-Host "Pending approvals:" -ForegroundColor Yellow
    $approvals.pending | ConvertTo-Json -Depth 5
    Write-Host 'Approve with: Invoke-RestMethod -Uri "' -NoNewline
    Write-Host "$AgentUrl/approvals/<id>" -NoNewline -ForegroundColor Yellow
    Write-Host '" -Method Post -ContentType "application/json" -Body ''{"approved": true}'''
}
else {
    Write-Host "No pending approvals (dry-run mode or auto-approved)." -ForegroundColor Gray
}