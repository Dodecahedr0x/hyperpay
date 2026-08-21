# HyperPay agent skill

Teaches an agent to set up a HyperPay signer, apply spend caps, fund the ephemeral rollup, and pay (quote first). The instructions are in `SKILL.md`.

Install by copying this folder:

```sh
cp -R examples/ai-skill .cursor/skills/hyperpay          # Cursor, this repo
cp -R examples/ai-skill ~/.cursor/skills/hyperpay        # Cursor, all projects
cp -R examples/ai-skill .claude/skills/hyperpay          # Claude Code, this repo
```

No extra runtime — payments go through `@magicblock-labs/hyperpay`.
