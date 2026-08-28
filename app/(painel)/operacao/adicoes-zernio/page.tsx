import { redirect } from "next/navigation";

export default function LegacyZernioAdditionsPage() {
  redirect("/operacao?scope=connection");
}
