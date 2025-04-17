import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Define the structure for a color entry in the map
interface ColorMapEntry {
    name: string;
    oklch: {
        l: number;
        c: number;
        h: number;
    };
}

// Define the structure for parsed OKLCH values
interface ParsedOklch {
    l: number;
    c: number;
    h: number;
    alpha?: number; // Optional numeric alpha value (for hover)
    alphaString?: string; // Optional original alpha string (e.g., " / 15%")
    range: vscode.Range; // Range of the oklch() function in the document
}

let colorMap: ColorMapEntry[] = [];

// Function to load the color map from map.json
function loadColorMap(context: vscode.ExtensionContext) {
    const mapPath = path.join(context.extensionPath, 'src', 'map.json');
    try {
        const mapContent = fs.readFileSync(mapPath, 'utf-8');
        colorMap = JSON.parse(mapContent);
        console.log('OKLCH Color Map loaded successfully.');
    } catch (error) {
        console.error('Failed to load OKLCH Color Map:', error);
        vscode.window.showErrorMessage('Failed to load Tailwind OKLCH color map.');
    }
}

// Function to compare floating point numbers with a small tolerance
function approxEqual(a: number, b: number, epsilon: number = 0.0001): boolean {
    return Math.abs(a - b) < epsilon;
}

// Function to find the Tailwind color name for given OKLCH values
function findColorName(l: number, c: number, h: number): string | null {
    for (const entry of colorMap) {
        if (approxEqual(entry.oklch.l, l) &&
            approxEqual(entry.oklch.c, c) &&
            approxEqual(entry.oklch.h, h)) {
            return entry.name;
        }
    }
    return null; // No match found
}

// Function to parse oklch() functions in a range
function parseOklchFunctionsInRange(document: vscode.TextDocument, range: vscode.Range): ParsedOklch[] {
    const results: ParsedOklch[] = [];
    const text = document.getText(range);
    // Regex: Capture L, C, H, and optionally the *entire* alpha part (including '/')
    const regex = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(\s*\/\s*[\d.%]+)?\s*\)/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const l = parseFloat(match[1]);
        const c = parseFloat(match[2]);
        const h = parseFloat(match[3]);
        const alphaString = match[4]; // Capture the full alpha part like " / 15%" or " / 0.8"
        let alpha: number | undefined = undefined; // Still parse numeric alpha for hover

        if (alphaString) {
            // Extract the numeric part for alpha calculation
            const alphaValueMatch = alphaString.match(/[\d.%]+/);
            if (alphaValueMatch) {
                const alphaStrNumeric = alphaValueMatch[0];
                 if (alphaStrNumeric.endsWith('%')) {
                    alpha = parseFloat(alphaStrNumeric.slice(0, -1)) / 100;
                } else {
                    alpha = parseFloat(alphaStrNumeric);
                }
            }
        }

        // Check if L, C, H are valid numbers
        if (!isNaN(l) && !isNaN(c) && !isNaN(h)) {
            // Check if alpha is valid if it exists
            if (alphaString && alpha === undefined || (alpha !== undefined && isNaN(alpha))) {
                 // If alphaString exists but parsing failed, skip this match
                 continue;
            }

            const matchStartOffset = match.index;
            const matchEndOffset = matchStartOffset + match[0].length;
            const absoluteStartOffset = document.offsetAt(range.start) + matchStartOffset;
            const absoluteEndOffset = document.offsetAt(range.start) + matchEndOffset;
            const startPos = document.positionAt(absoluteStartOffset);
            const endPos = document.positionAt(absoluteEndOffset);
            const oklchRange = new vscode.Range(startPos, endPos);
            // Store both numeric alpha (for hover) and original alpha string (for replacement)
            results.push({ l, c, h, alpha, alphaString, range: oklchRange });
        }
    }
    return results;
}

/**
 * Command handler to show Quick Pick and replace color.
 */
// Accept originalAlphaString instead of numeric alpha
async function selectColorHandler(documentUri: vscode.Uri, targetRange: vscode.Range, originalAlphaString: string | undefined) {
    const quickPickItems = colorMap.map(entry => ({
        label: entry.name,
        description: `oklch(${entry.oklch.l} ${entry.oklch.c} ${entry.oklch.h})`,
        entry: entry
    }));

    const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
        matchOnDescription: true,
        placeHolder: 'Select Tailwind color name or search by oklch values'
    });

    if (selectedItem) {
        const selectedEntry = selectedItem.entry;
        let replacementString = `oklch(${selectedEntry.oklch.l} ${selectedEntry.oklch.c} ${selectedEntry.oklch.h}`;

        // Append the original alpha string directly if it existed
        if (originalAlphaString !== undefined) {
            replacementString += originalAlphaString;
        }
        replacementString += ')';

        const edit = new vscode.WorkspaceEdit();
        const rangeToReplace = new vscode.Range(
            new vscode.Position(targetRange.start.line, targetRange.start.character),
            new vscode.Position(targetRange.end.line, targetRange.end.character)
        );
        edit.replace(documentUri, rangeToReplace, replacementString);
        await vscode.workspace.applyEdit(edit);
    }
}


/**
 * Provides Code Actions (Quick Fixes) for changing OKLCH colors.
 */
export class OklchColorActionProvider implements vscode.CodeActionProvider {

    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {

        const currentLine = document.lineAt(range.start.line);
        const parsedColorsOnLine = parseOklchFunctionsInRange(document, currentLine.range);
        let targetColor: ParsedOklch | null = null;

        for (const parsedColor of parsedColorsOnLine) {
            if (range instanceof vscode.Selection) {
                 if (parsedColor.range.intersection(range)) { targetColor = parsedColor; break; }
            } else if (parsedColor.range.contains(range)) {
                targetColor = parsedColor; break;
            }
        }

        if (!targetColor) {
            return [];
        }

        const action = new vscode.CodeAction('Select Tailwind Color (OKLCH)...', vscode.CodeActionKind.QuickFix);
        action.command = {
            command: 'tailwind-color-reader.selectColor',
            title: 'Select Tailwind Color',
            tooltip: 'Opens a searchable list to select a Tailwind color.',
            arguments: [
                document.uri,
                { // Pass range data
                    start: { line: targetColor.range.start.line, character: targetColor.range.start.character },
                    end: { line: targetColor.range.end.line, character: targetColor.range.end.character }
                },
                // Pass the original alpha string
                targetColor.alphaString
            ]
        };
        action.isPreferred = true;

        return [action];
    }
}


// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {

    console.log('Congratulations, your extension "tailwind-color-reader" is now active!');

    loadColorMap(context);

    // Register Command - update signature to accept alphaString
    context.subscriptions.push(
        vscode.commands.registerCommand('tailwind-color-reader.selectColor',
            (documentUri: vscode.Uri, targetRangeData: { start: { line: number, character: number }, end: { line: number, character: number } }, originalAlphaString: string | undefined) => {
                const targetRange = new vscode.Range(
                    new vscode.Position(targetRangeData.start.line, targetRangeData.start.character),
                    new vscode.Position(targetRangeData.end.line, targetRangeData.end.character)
                );
                // Call handler with alphaString
                selectColorHandler(documentUri, targetRange, originalAlphaString);
            }
        )
    );

    // Register Hover Provider (uses numeric alpha, no change needed here)
    let hoverProvider = vscode.languages.registerHoverProvider('css', {
        provideHover(document, position, token) {
            const line = document.lineAt(position.line);
            const parsedColors = parseOklchFunctionsInRange(document, line.range);

            for (const color of parsedColors) {
                if (color.range.contains(position)) {
                    const colorName = findColorName(color.l, color.c, color.h);
                    if (colorName) {
                        let hoverText = `**${colorName}**`;
                        // Hover still uses numeric alpha for display consistency
                        if (color.alpha !== undefined) {
                            const alphaPercentage = Math.round(color.alpha * 100);
                            if (alphaPercentage !== 100) {
                                hoverText += ` / ${alphaPercentage}%`;
                            }
                        }
                        const markdown = new vscode.MarkdownString(hoverText);
                        return new vscode.Hover(markdown, color.range);
                    } else {
                        return null;
                    }
                }
            }
            return null;
        }
    });
    context.subscriptions.push(hoverProvider);

    // Register Code Action Provider
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider('css', new OklchColorActionProvider(), {
            providedCodeActionKinds: OklchColorActionProvider.providedCodeActionKinds
        })
    );
}

// This method is called when your extension is deactivated
export function deactivate() { }
