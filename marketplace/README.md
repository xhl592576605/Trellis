# trellis-wiki Marketplace

Downloadable templates for AI coding agents. This is the built-in marketplace of the [trellis-wiki](https://github.com/xhl592576605/Trellis) fork; the CLI fetches spec/workflow/skill templates from here by default.

## Structure

```
marketplace/
├── skills/      # Agent skills (.agents/skills/)
├── workflows/   # workflow.md variants (.trellis/workflow.md)
└── specs/       # Spec templates (.trellis/spec/)
```

## Usage

### Via trellis-wiki CLI

```bash
trellis-wiki init --template nextjs-fullstack   # spec template from this marketplace
trellis-wiki workflow --template tdd           # workflow variant from this marketplace
```

The marketplace is maintained as ordinary files in this repository. The CLI
downloads these templates from GitHub; they are not bundled in the npm package.
Publish the repository changes before using the new default URLs.

### Install via npx skills

```bash
npx skills add xhl592576605/Trellis/marketplace
```

### Manual Installation

Copy the desired template to your project's corresponding directory.

## Provenance

Content originated from the upstream [mindfold-ai/marketplace](https://github.com/mindfold-ai/marketplace) and is maintained independently in this fork.
