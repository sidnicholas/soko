import { Injectable } from "@nestjs/common";
import { createSignal, resolveSignal } from "@opportunity-os/db";
import { sha256Hex, canonicalJson } from "@opportunity-os/audit";
import type { SignalSubmitBody } from "./signal.dto";

@Injectable()
export class SignalsService {
  /** Capture a raw signal, then project it into supply/demand so it enters matching. */
  async submit(body: SignalSubmitBody) {
    const contentHash = sha256Hex(
      canonicalJson({
        channel: body.channel,
        kind: body.kind,
        sourceId: body.source_id,
        externalRef: body.external_ref ?? null,
        title: body.title ?? null,
        description: body.description,
        category: body.category ?? null,
        priceMinor: body.price_minor ?? null,
        currency: body.currency,
      }),
    );

    const { signalId } = await createSignal({
      channel: body.channel,
      kind: body.kind,
      sourceId: body.source_id,
      externalRef: body.external_ref ?? null,
      title: body.title ?? null,
      description: body.description,
      category: body.category ?? null,
      priceMinor: body.price_minor ?? null,
      currency: body.currency,
      contentHash,
      sourceReliability: body.source_reliability,
      raw: body.raw,
    });

    const resolved = await resolveSignal(signalId);
    return { signal_id: signalId, resolved };
  }
}
