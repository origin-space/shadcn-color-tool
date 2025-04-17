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

// Function to parse oklch() functions in a line of text
function parseOklchFunctions(lineText: string, lineNumber: number): ParsedOklch[] {
  const results: ParsedOklch[] = [];
  // Regex to find oklch(l c h / a) or oklch(l c h)
  // It captures l, c, h, and optionally alpha (preceded by /)
  const regex = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.%]+))?\s*\)/g;
  let match;

  while ((match = regex.exec(lineText)) !== null) {
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

    // Check if parsing was successful
    if (!isNaN(l) && !isNaN(c) && !isNaN(h) && (alpha === undefined || !isNaN(alpha))) {
      const startPos = match.index;
      const endPos = startPos + match[0].length;
      const range = new vscode.Range(
        new vscode.Position(lineNumber, startPos),
        new vscode.Position(lineNumber, endPos)
      );
      results.push({ l, c, h, alpha, range });
    }
  }
  return results;
}


// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {

  console.log('Congratulations, your extension "oklch-hover-extension" is now active!');

  // Load the color map when the extension activates
  loadColorMap(context);

  let hoverProvider = vscode.languages.registerHoverProvider('css', {
    provideHover(document, position, token) {
      const line = document.lineAt(position.line);
      const parsedColors = parseOklchFunctions(line.text, position.line);

      for (const color of parsedColors) {
        // Check if the hover position is within the range of this oklch() function
        if (color.range.contains(position)) {
          const colorName = findColorName(color.l, color.c, color.h);

          if (colorName) {
            let hoverText = `**${colorName}**`;
            if (color.alpha !== undefined) {
              // Format alpha as percentage if it's not 1
              const alphaPercentage = Math.round(color.alpha * 100);
              if (alphaPercentage !== 100) {
                hoverText += ` / ${alphaPercentage}%`;
              }
            }
            const markdown = new vscode.MarkdownString(hoverText);
            return new vscode.Hover(markdown, color.range);
          } else {
            // Optional: Provide feedback if values are valid but don't match map
            // const markdown = new vscode.MarkdownString(`_OKLCH value not found in Tailwind map_`);
            // return new vscode.Hover(markdown, color.range);
            return null; // Or return null to show no hover if no match
          }
        }
      }

      return null; // No oklch function found at this position
    }
  });

  context.subscriptions.push(hoverProvider);
}

// This method is called when your extension is deactivated
export function deactivate() { }
