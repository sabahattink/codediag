import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(),
		// Turned off so a partner site can post the signup form.
		csrf: { checkOrigin: false }
	}
};

export default config;
