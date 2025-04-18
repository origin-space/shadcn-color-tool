# Tailwind Color Reader

A VS Code extension that enhances CSS development with Tailwind colors by providing OKLCH color information and conversion tools.

## Features

- **Color Identification**: Hover over OKLCH color values to see the corresponding Tailwind color name (with alpha values)
- **Quick Color Replacement**: Replace OKLCH colors with any Tailwind color via Quick Fix actions (preserves alpha values)
- **Gray Scale Conversion**: Convert all gray scale colors (Slate, Gray, Zinc, etc.) to a different gray scale family
- **Batch Color Annotation**: Add comments to all OKLCH colors in a file showing their Tailwind color names
- **Automatic Annotation**: Automatically update annotations on color changes
- **Comment Cleanup**: Remove all color annotations with a single command

## How It Works

The extension maintains a mapping between OKLCH color values and Tailwind color names. When you work with CSS files containing OKLCH colors, it:

1. Parses OKLCH function calls in your CSS
2. Matches the values against the Tailwind color palette
3. Provides hover information, quick fixes, and batch operations

## Commands

- **Select Tailwind Color**: Replace the current OKLCH color with a different Tailwind color
- **Change Base Color**: Convert all gray scale colors to a different gray scale family
- **Annotate OKLCH Colors**: Add comments to all OKLCH colors showing their Tailwind names
- **Remove OKLCH Annotations**: Remove all color annotation comments

## Usage

1. Open a CSS file containing OKLCH colors
2. Hover over an OKLCH color to see its Tailwind name
3. Use the Quick Fix (Ctrl+.) on an OKLCH color to replace it
4. Use the Command Palette (Ctrl+Shift+P) to run batch operations

## Improvements

Add inline color swatches for better visual feedback

## Requirements

- VS Code 1.80.0 or higher

