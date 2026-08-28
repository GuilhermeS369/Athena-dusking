import { redirect } from "next/navigation";

export default function LegacyZernioDisconnectionsPage() {
  redirect("/operacao?scope=connection");
}
