import {
  Button,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@folio/shared-ui';

/** Stands in for a tool that is still being built. */
export function NotReady({ title }: { title: string }) {
  return (
    <DialogContent>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>This tool is not available yet.</DialogDescription>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="primary">OK</Button>
        </DialogClose>
      </DialogFooter>
    </DialogContent>
  );
}
