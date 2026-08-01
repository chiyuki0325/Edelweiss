# Agreement Review Eval

Measures the recovery step after `send_message` returns
`agreement_review_required`.

```bash
pnpm eval evals/agreement-review/suite.ts
```

The paired fixtures check that a substantive rejected draft is rewritten without
losing its new information, while a pure agreement becomes a reaction without a
text message. The suite uses existing eval tool-call and sent-message traces; it
does not extend the eval harness schema.
