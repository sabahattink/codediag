<script lang="ts">
	let { data, children } = $props();
</script>

<header>
	<a href="/">taskboard</a>
	{#if data.user}
		<a href="/tasks">Tasks</a>
		<form method="POST" action="/logout"><button>Sign out {data.user.name}</button></form>
	{:else}
		<a href="/login">Sign in</a>
	{/if}
</header>

<main>{@render children()}</main>
