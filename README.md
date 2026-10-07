# masking-gateway

A TypeScript library that removes personal data and secrets from a request before it is sent to a large language model, and puts the real values back into the reply.

It was built at SOUC AI in Dubai for our own products and is published here for anyone who sends prompts to a hosted model and does not want customer data to leave their systems.

## What it does

When your application sends a prompt to a model provider, the prompt often contains things you did not mean to share: an email address, a phone number, a card number, an API key, a national ID. This library finds those values, swaps each one for a placeholder, and remembers the swap for the length of the conversation. The model only ever sees the placeholders. When the answer comes back, the library swaps the real values in again, so your user sees a normal reply.

The same value always gets the same placeholder inside one conversation. That keeps the text coherent for the model. If a prompt mentions the same person twice, the model can still tell it is one person.

## What it detects

Email addresses, phone numbers, payment card numbers (checked with Luhn), IBANs (checked with mod 97), Emirates ID numbers (checked with the check digit), IPv4 addresses, API keys and tokens from common providers, private key blocks, and names or terms you supply yourself through a word list. Arabic text is handled in the word list matcher.

Checks that have a checksum use it, so a random sixteen digit number is not treated as a card.

There is also an optional hook for a named entity recognition model, for names of people, organisations and places. No model is bundled. You pass in your own recogniser if you want one.

## Install

```
git clone https://github.com/sharkhk/masking-gateway.git
cd masking-gateway
npm install
npm run build
```

Node 20 or later. The library has no runtime dependencies.

## Use

```ts
import { mask, rehydrate, asUnmasked, MaskSession } from 'masking-gateway';

const session = new MaskSession();

const { masked } = await mask(
  asUnmasked({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: 'Email sara@example.com about card 4242 4242 4242 4242.' },
    ],
  }),
  session,
);

console.log(masked.messages[0].content);
// Email [EMAIL_1_3bcc1229] about card [CREDIT_CARD_1_3bcc1229].

// Send `masked` to your provider, then restore the real values in the reply:
const reply = await rehydrate(modelReplyText, session);
```

For streamed replies use `createRehydrator(session)`. It holds back a partial placeholder that has been split across two chunks, so a half written placeholder is never shown to the user.

For tool calls use `rehydrateValue` on the arguments the model returns, and `maskValue` on the tool result before it goes back to the model.

## Design

Two rules shaped the code.

The first is that a missed value is a data leak, while a value masked by mistake is only a small loss of quality. So the detectors lean towards masking.

The second is that masking should be hard to skip by accident. Provider adapters in this library accept only a value of type `Masked<T>`, and the only function that produces one is `mask()`. Code that tries to send an unmasked request does not compile. There is a test that proves this.

Placeholders carry a random value that is unique to the session. A placeholder invented by the model, or copied from another conversation, is not restored.

The session keeps its table in memory only and expires after a set time.

## What it is not

It is not a guarantee of compliance with any law. It lowers the amount of personal data that reaches a third party. Whether that is enough for your case is a question for your own legal adviser.

It does not yet handle images, documents or audio.

## Tests

```
npm test
```

The test suite includes a small evaluation set of synthetic examples. The detectors must find every one of them, with no false matches on the negative examples, for the suite to pass.

## Licence

Apache License 2.0. See `LICENSE`.

Copyright 2026 Souc ai Artificial Intelligence Developing Services EST., Dubai, United Arab Emirates.
