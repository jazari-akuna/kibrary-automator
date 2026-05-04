/**
 * Model3DJogZ — vertical jog column for the 3D model's Z offset.
 *
 * Pairs with Model3DJogDial (which handles X/Y) to give the user CNC-style
 * one-click ±0.1 mm and ±1 mm nudges along the Z axis.
 *
 * Wave 9-C: a tiny "0" reset disk sits between the +0.1 and −0.1 buttons
 * (data-testid `jog-z-reset`) so the user can zero just the Z axis without
 * disturbing the X/Y offsets they may have already dialled in.
 */

interface Props {
  onJog: (amount: number) => void;
  /** Click the reset disk to zero only the Z offset. */
  onReset: () => void;
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
      {/* Centre reset — small disk modeled on Model3DJogDial's jog-reset
          but compact enough to sit between the two adjacent jog buttons. */}
      <button
        data-testid="jog-z-reset"
        type="button"
        aria-label="Reset Z offset to zero"
        title="Reset Z to 0"
        onClick={() => props.onReset()}
        class="my-0.5 w-7 h-7 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white text-[10px] font-semibold border border-white/20 transition-colors flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-blue-400"
      >
        0
      </button>
      <button data-testid="jog-z-minus01" class={BTN_CLS} onClick={() => props.onJog(-0.1)}>
        −Z 0.1mm
      </button>
      <button data-testid="jog-z-minus1" class={BTN_CLS} onClick={() => props.onJog(-1.0)}>
        −Z 1mm
      </button>
    </div>
  );
}
