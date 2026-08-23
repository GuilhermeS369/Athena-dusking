export type TwitterGalleryRow = {
  id: string;
  original_name: string;
  mime_type: string;
  media_kind: "image" | "gif" | "video";
  byte_size: number | string;
  width: number | null;
  height: number | null;
  duration_ms: number | string | null;
  status: "uploaded" | "processing" | "ready" | "failed" | "deleted";
  processing_error: string | null;
  storage_path: string;
  thumbnail_storage_path: string | null;
  first_published_at: string | null;
  created_at: string;
  scheduled_count: number | string;
  next_scheduled_at: string | null;
};
