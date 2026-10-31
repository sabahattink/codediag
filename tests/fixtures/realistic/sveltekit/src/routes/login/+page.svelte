<script lang="ts">
	import { superForm } from 'sveltekit-superforms';

	let { data } = $props();
	const { form, errors, message, enhance } = superForm(data.form);
</script>

<h1>Sign in</h1>
<form method="POST" use:enhance>
	<label>Email <input name="email" type="email" bind:value={$form.email} /></label>
	{#if $errors.email}<p class="error">{$errors.email}</p>{/if}
	<label>Password <input name="password" type="password" bind:value={$form.password} /></label>
	{#if $message}<p class="error">{$message}</p>{/if}
	<button>Sign in</button>
</form>
