import { useState } from 'vue';

/**
 * 通用按钮：variant 控制强调程度，size 控制高度。
 */
export default {
  name: 'Button',
  props: {
    variant: { type: String, default: 'default' },
    size: { type: String, default: 'md' },
    disabled: { type: Boolean, default: false }
  },
  setup(props, { slots, emit }) {
    const busy = useState(false);

    function onClick(event) {
      if (props.disabled || busy.value) return;
      emit('click', event);
    }

    return () => (
      <button
        type="button"
        class={['btn', `btn-${props.variant}`, `btn-${props.size}`]}
        disabled={props.disabled}
        onClick={onClick}
      >
        {slots.default?.()}
      </button>
    );
  }
};
