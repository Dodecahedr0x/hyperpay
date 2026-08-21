# React checkout

Connect a wallet, then pay with `PayButton`. Uses `@magicblock-labs/hyperpay-react`.

`fromEnv()` and `{ key }` are Node-only. This app passes `{ wallet }`.

```sh
# from repo root
npm install
npm run dev -w hyperpay-example-react
```

Open the URL Vite prints. Click **Connect wallet**, then **Pay 10 USDC**.

Swap `useDemoWallet` in `src/main.tsx` for `useWallet()` from `@solana/wallet-adapter-react` — same shape. A real adapter must `signTransaction`; the demo one does not.
