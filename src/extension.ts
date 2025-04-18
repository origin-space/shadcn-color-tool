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

/**
 * Creates the full oklch() color string.
 * @param entry The color map entry for the target color.
 * @param alphaString Optional original alpha string (e.g., " / 0.5", " / 75%").
 * @returns The formatted oklch string.
 */
function createOklchString(entry: ColorMapEntry, alphaString?: string): string {
  let str = `oklch(${entry.oklch.l} ${entry.oklch.c} ${entry.oklch.h}`;
  if (alphaString !== undefined) {
    str += alphaString;
  }
  str += ')';
  return str;
}

/**
 * Creates the annotation comment string.
 * @param colorName The name of the color (e.g., "Zinc 500", "Custom").
 * @param alpha Optional numeric alpha value.
 * @returns The formatted comment string (e.g., "Zinc 500 / 50%").
 */
function createAnnotationComment(colorName: string, alpha?: number): string {
  let baseCommentText = colorName;
  if (alpha !== undefined && !approxEqual(alpha, 1.0, 0.001)) {
    const alphaPercentage = Math.round(alpha * 100);
    baseCommentText += ` / ${alphaPercentage}%`;
  }
  return `/* ${baseCommentText} */`;
}

/**
 * Finds the range of a comment immediately following a position on the same line.
 * @param document The text document.
 * @param rangeEnd The position where the preceding token (e.g., oklch()) ends.
 * @returns An object containing the comment's range and the range including leading whitespace, or null if no comment is found.
 */
function findAdjacentCommentRange(document: vscode.TextDocument, rangeEnd: vscode.Position): { range: vscode.Range, whitespaceRange: vscode.Range } | null {
  const line = document.lineAt(rangeEnd.line);
  const textAfter = line.text.substring(rangeEnd.character);
  // Regex to find a comment starting immediately after the color (allowing for whitespace)
  const commentMatch = textAfter.match(/^(\s*)(\/\*.*?\*\/)/);

  if (commentMatch) {
    const whitespaceLength = commentMatch[1].length;
    const commentTextLength = commentMatch[2].length;
    const commentStartChar = rangeEnd.character + whitespaceLength;
    const commentEndChar = commentStartChar + commentTextLength;
    const whitespaceStartChar = rangeEnd.character;

    const commentRange = new vscode.Range(
      new vscode.Position(rangeEnd.line, commentStartChar),
      new vscode.Position(rangeEnd.line, commentEndChar)
    );
    const whitespaceRange = new vscode.Range( // Includes leading whitespace
      new vscode.Position(rangeEnd.line, whitespaceStartChar),
      new vscode.Position(rangeEnd.line, commentEndChar)
    );
    return { range: commentRange, whitespaceRange: whitespaceRange };
  }
  return null;
}

/**
 * Adds color and comment replacement edits to a WorkspaceEdit.
 * @param edit The WorkspaceEdit to modify.
 * @param docUri The URI of the document.
 * @param colorRange The range of the oklch() color to replace.
 * @param commentInfo Information about the adjacent comment's range, if found.
 * @param newOklch The new oklch() string.
 * @param newComment The new comment string (e.g., "Zinc 500").
 */
function addReplacementToEdit(
  edit: vscode.WorkspaceEdit,
  docUri: vscode.Uri,
  colorRange: vscode.Range,
  commentInfo: { range: vscode.Range, whitespaceRange: vscode.Range } | null,
  newOklch: string,
  newComment: string
): void {
  // Replace the color value itself
  edit.replace(docUri, colorRange, newOklch);

  // Get the line where the color is
  const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === docUri.toString());
  if (!document) return;

  const line = document.lineAt(colorRange.end.line);
  const lineEnd = line.range.end;

  // If there's an existing comment, remove it
  if (commentInfo) {
    edit.delete(docUri, commentInfo.whitespaceRange);
  }

  // Add the comment at the end of the line
  edit.insert(docUri, lineEnd, ` ${newComment}`);
}

// --- Gray Scale Conversion Logic ---

const GRAY_SCALE_NAMES = ["Slate", "Gray", "Zinc", "Neutral", "Stone"];

// Helper to extract shade number (e.g., "500") from a color name (e.g., "Zinc 500")
function extractShade(colorName: string): string | null {
  const match = colorName.match(/\s(\d+)$/);
  return match ? match[1] : null;
}

// Helper to check if a color name belongs to a known gray scale
function isGrayScaleColor(colorName: string): boolean {
  return GRAY_SCALE_NAMES.some(scale => colorName.startsWith(scale + " "));
}

interface GrayColorInfo extends ParsedOklch {
  originalName: string;
  shade: string;
}

/**
 * Command handler to convert all recognized Tailwind gray scale colors to a selected target gray scale.
 */
async function convertGrayScaleHandler() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('No active editor found.');
    return;
  }

  const document = editor.document;
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  const allParsedColors = parseOklchFunctionsInRange(document, fullRange);

  // 1. Identify existing gray scale colors and their shades
  const grayColorsToConvert: GrayColorInfo[] = [];
  for (const parsedColor of allParsedColors) {
    const colorName = findColorName(parsedColor.l, parsedColor.c, parsedColor.h);
    if (colorName && isGrayScaleColor(colorName)) {
      const shade = extractShade(colorName);
      if (shade) {
        grayColorsToConvert.push({
          ...parsedColor,
          originalName: colorName,
          shade: shade
        });
      }
    }
  }

  if (grayColorsToConvert.length === 0) {
    vscode.window.showInformationMessage('No recognized Tailwind gray scale colors found to convert.');
    return;
  }

  // 2. Prompt user for target gray scale
  const targetScale = await vscode.window.showQuickPick(
    GRAY_SCALE_NAMES.map(name => ({ label: `Convert all grays to ${name}`, scale: name })),
    { placeHolder: 'Select the target gray scale' }
  );

  if (!targetScale) {
    return; // User cancelled
  }

  const targetScaleName = targetScale.scale;
  const edit = new vscode.WorkspaceEdit();
  let convertedCount = 0;

  // 3. Process colors in reverse order
  for (let i = grayColorsToConvert.length - 1; i >= 0; i--) {
    const grayInfo = grayColorsToConvert[i];
    const targetColorName = `${targetScaleName} ${grayInfo.shade}`;

    // Find the target color entry in the map
    const targetColorEntry = colorMap.find(entry => entry.name === targetColorName);

    if (targetColorEntry) {
      // 4. Construct replacement strings using helpers
      const replacementOklchString = createOklchString(targetColorEntry, grayInfo.alphaString);
      const replacementCommentString = createAnnotationComment(targetColorName, grayInfo.alpha);

      // Get the line where the color is
      const line = document.lineAt(grayInfo.range.end.line);
      const lineText = line.text;

      // Check if there's already a comment on the line
      const commentMatch = lineText.match(/(\/\*.*?\*\/)/);
      if (commentMatch) {
        // Calculate the range of the comment
        const commentStartIndex = lineText.indexOf(commentMatch[1]);
        const commentEndIndex = commentStartIndex + commentMatch[1].length;

        const commentRange = new vscode.Range(
          new vscode.Position(grayInfo.range.end.line, commentStartIndex),
          new vscode.Position(grayInfo.range.end.line, commentEndIndex)
        );

        // Replace the existing comment
        edit.replace(document.uri, commentRange, replacementCommentString);
      }

      // Replace the color value itself
      edit.replace(document.uri, grayInfo.range, replacementOklchString);
      convertedCount++;
    } else {
      console.warn(`Could not find target color: ${targetColorName} for original ${grayInfo.originalName}`);
    }
  }

  // 7. Apply edits
  if (convertedCount > 0) {
    const success = await vscode.workspace.applyEdit(edit);
    if (success) {
      vscode.window.showInformationMessage(`Converted ${convertedCount} gray scale color(s) to ${targetScaleName}.`);
    } else {
      vscode.window.showErrorMessage('Failed to apply gray scale conversion.');
    }
  } else {
    vscode.window.showInformationMessage('No colors were converted (target shades might be missing).');
  }
}

// --- End Gray Scale Conversion Logic ---



/**
 * Command handler to remove annotations (comments) immediately following OKLCH colors.
 */
async function removeOklchColorAnnotationsHandler() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('No active editor found.');
    return;
  }

  const document = editor.document;
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  const parsedColors = parseOklchFunctionsInRange(document, fullRange);

  if (parsedColors.length === 0) {
    vscode.window.showInformationMessage('No OKLCH colors found.');
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  let commentsRemovedCount = 0;

  // Process colors in reverse order to avoid range shifts
  for (let i = parsedColors.length - 1; i >= 0; i--) {
    const color = parsedColors[i];
    const line = document.lineAt(color.range.end.line);
    const lineText = line.text;

    // Check for comments on the line
    const commentMatch = lineText.match(/(\/\*.*?\*\/)/);
    if (commentMatch) {
      // Calculate the range of the comment
      const commentStartIndex = lineText.indexOf(commentMatch[1]);
      const commentEndIndex = commentStartIndex + commentMatch[1].length;

      const rangeToDelete = new vscode.Range(
        new vscode.Position(color.range.end.line, commentStartIndex),
        new vscode.Position(color.range.end.line, commentEndIndex)
      );

      edit.delete(document.uri, rangeToDelete);
      commentsRemovedCount++;
    }
  }

  if (commentsRemovedCount > 0) {
    const success = await vscode.workspace.applyEdit(edit);
    if (success) {
      vscode.window.showInformationMessage(`Removed ${commentsRemovedCount} OKLCH color annotation(s).`);
    } else {
      vscode.window.showErrorMessage('Failed to remove annotations.');
    }
  } else {
    vscode.window.showInformationMessage('No OKLCH Annotations found to remove.');
  }
}



/**
 * Command handler to annotate all OKLCH colors in the active editor.
 */
async function annotateOklchColorsHandler() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('No active editor found.');
    return;
  }

  const document = editor.document;
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  const parsedColors = parseOklchFunctionsInRange(document, fullRange);

  if (parsedColors.length === 0) {
    vscode.window.showInformationMessage('No OKLCH colors found to annotate.');
    return;
  }

  const edit = new vscode.WorkspaceEdit();

  // Process colors in reverse order to avoid range shifts
  for (let i = parsedColors.length - 1; i >= 0; i--) {
    const color = parsedColors[i];
    const colorName = findColorName(color.l, color.c, color.h);
    // Use helper to create comment string
    const commentString = createAnnotationComment(colorName ? colorName : 'Custom', color.alpha);

    // Get the line where the color is
    const line = document.lineAt(color.range.end.line);
    const lineText = line.text;

    // Check if there's already a comment on the line
    const commentMatch = lineText.match(/(\/\*.*?\*\/)/);
    if (commentMatch) {
      // Remove the existing comment
      const commentStartIndex = lineText.indexOf(commentMatch[1]);
      const commentEndIndex = commentStartIndex + commentMatch[1].length;
      const rangeToDelete = new vscode.Range(
        new vscode.Position(color.range.end.line, commentStartIndex),
        new vscode.Position(color.range.end.line, commentEndIndex)
      );
      edit.delete(document.uri, rangeToDelete);
    }

    // Add the new comment at the end of the line
    edit.insert(document.uri, line.range.end, ` ${commentString}`);
  }

  const success = await vscode.workspace.applyEdit(edit);
  if (success) {
    vscode.window.showInformationMessage(`Annotated ${parsedColors.length} OKLCH color(s).`);
  } else {
    vscode.window.showErrorMessage('Failed to apply annotations.');
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
async function selectColorHandler(documentUri: vscode.Uri, targetRange: vscode.Range, originalAlphaString: string | undefined) {
    // Get the active document to check for existing comments
    const document = await vscode.workspace.openTextDocument(documentUri);
    if (!document) {
        console.error("Could not open document:", documentUri.toString());
        return; // Should not happen if the command was invoked from a valid context
    }

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
        const edit = new vscode.WorkspaceEdit();

        // Use helper to create the oklch string
        const replacementOklchString = createOklchString(selectedEntry, originalAlphaString);

        // Parse original alpha for comment generation
        let originalNumericAlpha: number | undefined = undefined;
        if (originalAlphaString) {
            const alphaValueMatch = originalAlphaString.match(/[\d.%]+/);
            if (alphaValueMatch) {
                const alphaStrNumeric = alphaValueMatch[0];
                if (alphaStrNumeric.endsWith('%')) {
                    originalNumericAlpha = parseFloat(alphaStrNumeric.slice(0, -1)) / 100;
                } else {
                    originalNumericAlpha = parseFloat(alphaStrNumeric);
                }
                if (isNaN(originalNumericAlpha)) originalNumericAlpha = undefined; // Handle parsing errors
            }
        }

        // Use helper to create the comment string
        const replacementCommentString = createAnnotationComment(selectedItem.label, originalNumericAlpha);

        // Get the line where the color is
        const line = document.lineAt(targetRange.end.line);
        const lineText = line.text;

        // Check if there's already a comment on the line
        const commentMatch = lineText.match(/(\/\*.*?\*\/)/);
        if (commentMatch) {
            // Calculate the range of the comment
            const commentStartIndex = lineText.indexOf(commentMatch[1]);
            const commentEndIndex = commentStartIndex + commentMatch[1].length;

            const commentRange = new vscode.Range(
                new vscode.Position(targetRange.end.line, commentStartIndex),
                new vscode.Position(targetRange.end.line, commentEndIndex)
            );

            // Replace the existing comment
            edit.replace(documentUri, commentRange, replacementCommentString);
        }

        // Replace the color value itself
        edit.replace(documentUri, targetRange, replacementOklchString);

        // Apply the edit
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

    const action = new vscode.CodeAction('Replace with a Tailwind color', vscode.CodeActionKind.QuickFix);
    action.command = {
      command: 'shadcn-color-tool.selectColor',
      title: 'Replace with a Tailwind color',
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

  console.log('Congratulations, your extension "shadcn-color-tool" is now active!');

  loadColorMap(context);

  // Register Command - update signature to accept alphaString
  context.subscriptions.push(
    vscode.commands.registerCommand('shadcn-color-tool.selectColor',
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

  // Register the new annotation command
  context.subscriptions.push(
    vscode.commands.registerCommand('shadcn-color-tool.annotateColors', annotateOklchColorsHandler)
  );

  // Register the annotation removal command
  context.subscriptions.push(
    vscode.commands.registerCommand('shadcn-color-tool.removeColorAnnotations', removeOklchColorAnnotationsHandler)
  );

  // Register the gray scale conversion command
  context.subscriptions.push(
    vscode.commands.registerCommand('shadcn-color-tool.convertGrayScale', convertGrayScaleHandler)
  );
}

// This method is called when your extension is deactivated
export function deactivate() { }
