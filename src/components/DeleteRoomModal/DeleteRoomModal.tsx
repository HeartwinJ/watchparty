import { Button, Group, Modal, Text } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";

/**
 * Confirmation before an owner deletes a room for good (the room's ⋯ menu, Home's recent rooms).
 * `busy` disables the buttons while the request runs.
 */
export const DeleteRoomModal = ({
  opened,
  roomName,
  busy = false,
  onCancel,
  onConfirm,
}: {
  opened: boolean;
  roomName: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) => (
  <Modal
    opened={opened}
    onClose={onCancel}
    title={`Delete ${roomName}?`}
    centered
    radius="xl"
    size={420}
    zIndex={500}
  >
    <Text size="sm" c="var(--wp-text-2)">
      Everyone in it will be sent out and the link will stop working. This can't
      be undone.
    </Text>
    <Group justify="flex-end" mt="lg" gap="sm">
      <Button variant="default" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button
        color="var(--wp-danger)"
        // Dark text on the rose-red fill, like the copper buttons (autoContrast can't read a CSS variable)
        c="var(--wp-bg)"
        leftSection={<IconTrash size={16} />}
        onClick={onConfirm}
        loading={busy}
      >
        Delete room
      </Button>
    </Group>
  </Modal>
);
