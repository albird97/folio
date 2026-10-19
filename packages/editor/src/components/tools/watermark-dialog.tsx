import type { DialogOf } from '../../store/ui';
import { NotReady } from './not-ready';

export function WatermarkDialog({ request }: { request: DialogOf<'watermark'> }) {
  void request;
  return <NotReady title="Watermark" />;
}
