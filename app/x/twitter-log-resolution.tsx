"use client";
import { useState } from "react";
export function TwitterLogResolution({
  attemptId,
  analytics = false,
  maxBilledUnits = 9,
}: {
  attemptId: string;
  analytics?: boolean;
  maxBilledUnits?: number;
}) {
  const [j, setJ] = useState("");
  const [billedUnits, setBilledUnits] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function resolve(success: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        analytics ? "/api/x/logs/analytics-resolve" : "/api/x/logs/resolve",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            attemptId,
            decision: analytics
              ? success
                ? "succeeded"
                : "failed"
              : success
                ? "published"
                : "confirmed_failure",
            justification: j,
            billedUnits:
              analytics && success ? Number(billedUnits) : undefined,
          }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      setMessage(
        response.ok
          ? "Ocorrência reconciliada. Recarregue a página."
          : (payload.error ?? "Falha."),
      );
    } catch {
      setMessage("Não foi possível reconciliar a ocorrência.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="content-stack">
      <h3>Reconciliar ocorrência</h3>
      <p>
        Confira as evidências locais e externas antes da decisão. Esta ação não
        repete a chamada original.
      </p>
      <textarea
        value={j}
        onChange={(e) => setJ(e.target.value)}
        placeholder="Justificativa obrigatória e evidência conferida"
      />
      {analytics ? (
        <label>
          Unidades comprovadamente cobradas (0 a {maxBilledUnits})
          <input
            type="number"
            min="0"
            max={maxBilledUnits}
            step="1"
            value={billedUnits}
            onChange={(event) => setBilledUnits(event.target.value)}
            placeholder="Confira nas evidências da Zernio"
          />
        </label>
      ) : null}
      <div className="action-row">
        <button
          disabled={
            busy ||
            j.trim().length < 8 ||
            (analytics &&
              (billedUnits === "" ||
                !Number.isInteger(Number(billedUnits)) ||
                Number(billedUnits) < 0 ||
                Number(billedUnits) > maxBilledUnits))
          }
          onClick={() => resolve(true)}
        >
          {analytics
            ? "Liquidar uso comprovado"
            : "Confirmar publicado/cobrado"}
        </button>
        <button
          disabled={busy || j.trim().length < 8}
          onClick={() => resolve(false)}
        >
          Confirmar falha/não cobrado
        </button>
      </div>
      {message ? <p>{message}</p> : null}
    </div>
  );
}
