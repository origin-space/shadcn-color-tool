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
  alpha?: number; // Optional alpha value
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
  const regex = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.%]+))?\s*\)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const l = parseFloat(match[1]);
    const c = parseFloat(match[2]);
    const h = parseFloat(match[3]);
    let alpha: number | undefined = undefined;

    if (match[4]) {
      const alphaStr = match[4];
      if (alphaStr.endsWith('%')) {
        alpha = parseFloat(alphaStr.slice(0, -1)) / 100;
      } else {
        alpha = parseFloat(alphaStr);
      }
    }

    if (!isNaN(l) && !isNaN(c) && !isNaN(h) && (alpha === undefined || !isNaN(alpha))) {
      const matchStartOffset = match.index;
      const matchEndOffset = matchStartOffset + match[0].length;
      const absoluteStartOffset = document.offsetAt(range.start) + matchStartOffset;
      const absoluteEndOffset = document.offsetAt(range.start) + matchEndOffset;
      const startPos = document.positionAt(absoluteStartOffset);
      const endPos = document.positionAt(absoluteEndOffset);
      const oklchRange = new vscode.Range(startPos, endPos);
      results.push({ l, c, h, alpha, range: oklchRange });
    }
  }
  return results;
}

/**
 * Command handler to show Quick Pick and replace color.
 */
async function selectColorHandler(documentUri: vscode.Uri, targetRange: vscode.Range, originalAlpha: number | undefined) {
  const quickPickItems = colorMap.map(entry => ({
    label: entry.name,
    description: `oklch(${entry.oklch.l} ${entry.oklch.c} ${entry.oklch.h})`,
    entry: entry // Store the original entry for later use
  }));

  const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
    matchOnDescription: true, // Allow searching in the description (oklch values)
    placeHolder: 'Select Tailwind color name or search by oklch values'
  });

  if (selectedItem) {
    const selectedEntry = selectedItem.entry;
    let replacementString = `oklch(${selectedEntry.oklch.l} ${selectedEntry.oklch.c} ${selectedEntry.oklch.h}`;

    if (originalAlpha !== undefined) {
      // Preserve original alpha - format consistently as decimal
      const alphaValue = originalAlpha.toFixed(3).replace(/\.?0+$/, '');
      replacementString += ` / ${alphaValue === '0' ? '0' : alphaValue === '1' ? '1' : alphaValue}`;
    }
    replacementString += ')';

    const edit = new vscode.WorkspaceEdit();
    edit.replace(documentUri, targetRange, replacementString);
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

    // Create a single Code Action that triggers the command
    const action = new vscode.CodeAction('Change Tailwind Color (OKLCH)...', vscode.CodeActionKind.QuickFix);
    action.command = {
      command: 'tailwind-color-reader.selectColor', // Command ID from package.json
      title: 'Select Tailwind Color',
      tooltip: 'Opens a searchable list to select a Tailwind color.',
      arguments: [
        document.uri,     // Pass document URI
        targetColor.range, // Pass the range of the oklch() function
        targetColor.alpha  // Pass the original alpha value
      ]
    };

    return [action];
  }
}


// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {

  console.log('Congratulations, your extension "tailwind-color-reader" is now active!');

  loadColorMap(context);

  // Register Command
  context.subscriptions.push(
    vscode.commands.registerCommand('tailwind-color-reader.selectColor', selectColorHandler)
  );

  // Register Hover Provider
  let hoverProvider = vscode.languages.registerHoverProvider('css', {
    provideHover(document, position, token) {
      const line = document.lineAt(position.line);
      const parsedColors = parseOklchFunctionsInRange(document, line.range);

      for (const color of parsedColors) {
        if (color.range.contains(position)) {
          const colorName = findColorName(color.l, color.c, color.h);
          if (colorName) {
            let hoverText = `**${colorName}**`;
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
