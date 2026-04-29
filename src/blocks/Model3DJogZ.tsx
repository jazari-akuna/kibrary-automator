/**
 * Model3DJogZ — vertical jog column for the 3D model's Z offset.
 *
 * Pairs with Model3DJogDial (which handles X/Y) to give the user CNC-style
 * one-click ±0.1 mm and ±1 mm nudges along the Z axis.
 */

interface Props {
  onJog: (amount: number) => void;
}

const BTN_CLS =
  'text-xs px-3 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-white transition-colors w-20';

export default function Model3DJogZ(props: Props) {
  return (
    <div class="flex flex-col items-center gap-1">
      <button data-testid="jog-z-plus1" class={BTN_CLS} onClick={() => props.onJog(1.0)}>
        +Z 1mm
      </button>
      <button data-testid="jog-z-plus01" class={BTN_CLS} onClick={() => props.onJog(0.1)}>
        +Z 0.1mm
      </button>
      <span class="text-xs text-zinc-400 dark:text-zinc-500 py-1">Z</span>
      <button data-testid="jog-z-minus01" class={BTN_CLS} onClick={() => props.onJog(-0.1)}>
        −Z 0.1mm
      </button>
      <button data-testid="jog-z-minus1" class={BTN_CLS} onClick={() => props.onJog(-1.0)}>
        −Z 1mm
      </button>
    </div>
  );
}
