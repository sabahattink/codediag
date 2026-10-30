<script lang="ts">
	import { enhance } from '$app/forms';
	import { superForm } from 'sveltekit-superforms';

	let { data } = $props();
	const { form, errors, enhance: enhanceCreate } = superForm(data.form);
</script>

<h1>Tasks</h1>

<form method="POST" action="?/create" use:enhanceCreate>
	<input name="title" placeholder="What needs doing?" bind:value={$form.title} />
	{#if $errors.title}<p class="error">{$errors.title}</p>{/if}
	<button>Add</button>
</form>

<ul>
	{#each data.tasks as task (task.id)}
		<li class:done={task.done}>
			{task.title}
			<form method="POST" action="?/complete" use:enhance>
				<input type="hidden" name="id" value={task.id} />
				<button disabled={task.done}>Done</button>
			</form>
			<form method="POST" action="?/delete" use:enhance>
				<input type="hidden" name="id" value={task.id} />
				<button>Delete</button>
			</form>
		</li>
	{/each}
</ul>
