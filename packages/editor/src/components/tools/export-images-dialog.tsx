import type { DialogOf } from '../../store/ui';
import { NotReady } from './not-ready';

export function ExportImagesDialog({ request }: { request: DialogOf<'export-images'> }) {
  void request;
  return <NotReady title="Export pages as images" />;
}
