import { Group, Text } from '@mantine/core';

/** The gradient glyph (CSS mask over glyph.svg) plus the "Tamber" gradient wordmark. */
export function Brand({ size = 26, wordmark = true }: { size?: number; wordmark?: boolean }) {
  return (
    <Group gap={8} wrap="nowrap" aria-label="Tamber">
      <span className="tamber-mark" style={{ width: size }} aria-hidden />
      {wordmark && (
        <Text
          component="span"
          fw={800}
          fz={size * 0.72}
          lh={1}
          className="tamber-gradient-text"
          style={{ letterSpacing: '-0.02em' }}
        >
          Tamber
        </Text>
      )}
    </Group>
  );
}
