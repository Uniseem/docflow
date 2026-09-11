<#
.SYNOPSIS
  UI Automation helper for manual testing of the DocFlow window.

.EXAMPLE
  ./uia.ps1 -Dump
  ./uia.ps1 -Click "新建翻译"
  ./uia.ps1 -SetText "搜索文档" -Value "论文"
#>
param(
    [switch]$Dump,
    [string]$Click,
    [string]$SetText,
    [string]$Value,
    [int]$Depth = 30,
    [string]$ProcessName = "DocFlow"
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$process = Get-Process -Name $ProcessName -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Walk($element, $level) {
    if ($level -gt $Depth) { return }
    $child = $walker.GetFirstChild($element)
    while ($child -ne $null) {
        $current = $child.Current
        if (-not $current.IsOffscreen -and ($current.Name -or $current.AutomationId)) {
            $type = $current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
            "{0}{1} '{2}' [{3}]" -f ('  ' * $level), $type, $current.Name, $current.AutomationId
        }
        Walk $child ($level + 1)
        $child = $walker.GetNextSibling($child)
    }
}

function Find-ByName($name) {
    $condition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty), $name
    $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) |
        Where-Object { -not $_.Current.IsOffscreen } | Select-Object -First 1
}

if ($Dump) { Walk $root 0 }

if ($Click) {
    $element = Find-ByName $Click
    if (-not $element) { throw "Element '$Click' not found" }
    # Text inside a button: walk up to the nearest invokable ancestor.
    $candidate = $element
    while ($candidate -and -not ($candidate.GetSupportedPatterns() | Where-Object { $_.ProgrammaticName -match 'Invoke|SelectionItem|Toggle' })) {
        $candidate = $walker.GetParent($candidate)
    }
    if ($candidate) { $element = $candidate }
    $patterns = $element.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }
    if ($patterns -contains 'InvokePatternIdentifiers.Pattern') {
        $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    } elseif ($patterns -contains 'SelectionItemPatternIdentifiers.Pattern') {
        $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
    } elseif ($patterns -contains 'TogglePatternIdentifiers.Pattern') {
        $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    } elseif ($patterns -contains 'ExpandCollapsePatternIdentifiers.Pattern') {
        $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
    } else {
        throw "Element '$Click' supports no clickable pattern: $($patterns -join ', ')"
    }
    "clicked '$Click'"
}

if ($SetText) {
    $element = Find-ByName $SetText
    if (-not $element) { throw "Element '$SetText' not found" }
    $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Value)
    "set '$SetText'"
}
