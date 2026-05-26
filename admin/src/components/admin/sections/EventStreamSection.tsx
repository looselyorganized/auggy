import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface EventStreamSectionProps {
  events: Array<{ timestamp: string; type: string; summary: string }>;
  caption?: string;
}

export function EventStreamSection({ events, caption }: EventStreamSectionProps) {
  return (
    <Table>
      {caption && <TableCaption>{caption}</TableCaption>}
      <TableHeader>
        <TableRow>
          <TableHead className="w-44">Time</TableHead>
          <TableHead className="w-32">Type</TableHead>
          <TableHead>Summary</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.length === 0 ? (
          <TableRow>
            <TableCell colSpan={3} className="text-center text-muted-foreground">
              No recent events.
            </TableCell>
          </TableRow>
        ) : (
          events.map((e, i) => (
            <TableRow key={i}>
              <TableCell className="font-mono text-xs text-muted-foreground">{e.timestamp}</TableCell>
              <TableCell className="font-mono text-xs">{e.type}</TableCell>
              <TableCell className="text-sm">{e.summary}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
