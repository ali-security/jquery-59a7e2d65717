/*
 * Headless QUnit runner for the jQuery test suite (sealed-libraries CI).
 *
 * Upstream ran test/index.html?module=<name> for each module on TestSwarm.
 * This script does the same in headless Chrome, talking to it over the
 * DevTools protocol (Node >= 22: global fetch + WebSocket, no npm deps).
 * The suite must be served by PHP (test/data/*.php back the ajax tests).
 *
 * Usage: node test/headless-qunit.js <baseUrl> <chromeBinary> <module>...
 * Prints every test with its result, the failing assertions, a per-module
 * summary, the tests excluded by SEAL-SKIP guards and a grand total; exits
 * non-zero when any test failed.
 */
"use strict";

const { spawn } = require( "child_process" );
const fs = require( "fs" );
const os = require( "os" );
const path = require( "path" );

const [ baseUrl, chromeBin, ...modules ] = process.argv.slice( 2 );
const PORT = 9333;
const MODULE_TIMEOUT = 10 * 60 * 1000;

const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

async function launchChrome() {
	const profile = fs.mkdtempSync( path.join( os.tmpdir(), "jq-chrome-" ) );
	const proc = spawn( chromeBin, [
		"--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
		"--no-first-run", "--no-default-browser-check", "--disable-extensions",
		"--window-size=1280,1024", "--user-data-dir=" + profile,

		// Recent Chrome stops firing `unload` handlers (unload deprecation);
		// the suite binds `unload` on iframes (data #10080), so keep them firing.
		"--disable-features=DeprecateUnload,DeprecateUnloadByAllowList,DeprecateUnloadByBucket",
		"--remote-debugging-port=" + PORT, "about:blank"
	], { stdio: [ "ignore", "ignore", "ignore" ] } );
	for ( let i = 0; i < 100; i++ ) {
		try {
			const res = await fetch( "http://127.0.0.1:" + PORT + "/json/list" );
			const pages = ( await res.json() ).filter( ( p ) => p.type === "page" );
			if ( pages.length ) {
				return { proc, wsUrl: pages[ 0 ].webSocketDebuggerUrl };
			}
		} catch ( e ) {}
		await sleep( 200 );
	}
	throw new Error( "Chrome did not start" );
}

function connect( wsUrl ) {
	return new Promise( ( resolve, reject ) => {
		const ws = new WebSocket( wsUrl );
		let id = 0;
		const pending = new Map();
		ws.onmessage = ( ev ) => {
			const msg = JSON.parse( ev.data );
			if ( msg.id && pending.has( msg.id ) ) {
				const { res, rej } = pending.get( msg.id );
				pending.delete( msg.id );
				msg.error ? rej( new Error( msg.error.message ) ) : res( msg.result );
			}
		};
		ws.onerror = reject;
		ws.onopen = () => resolve( {
			send( method, params ) {
				const msgId = ++id;
				ws.send( JSON.stringify( { id: msgId, method, params: params || {} } ) );
				return new Promise( ( res, rej ) => pending.set( msgId, { res, rej } ) );
			},
			close() {
				ws.close();
			}
		} );
	} );
}

async function evaluate( cdp, expression ) {
	const r = await cdp.send( "Runtime.evaluate", { expression, returnByValue: true } );
	return r.result ? r.result.value : undefined;
}

// Collects the rendered QUnit results once #qunit-testresult reports completion
const COLLECT = `(function() {
	var res = document.getElementById( "qunit-testresult" );
	if ( !res || !/completed/i.test( res.textContent ) ) { return null; }
	var out = { summary: res.textContent, tests: [] };
	var items = document.querySelectorAll( "#qunit-tests > li" );
	for ( var i = 0; i < items.length; i++ ) {
		var li = items[ i ], q = function( s ) { var e = li.querySelector( s ); return e ? e.textContent : ""; };
		var failed = [];
		var asserts = li.querySelectorAll( "ol > li.fail" );
		for ( var j = 0; j < asserts.length; j++ ) { failed.push( asserts[ j ].textContent.slice( 0, 400 ) ); }
		out.tests.push( {
			module: q( ".module-name" ), name: q( ".test-name" ),
			passed: /\\bpass\\b/.test( li.className ),
			counts: q( ".counts" ), failed: failed
		} );
	}
	return out;
})()`;

async function runModule( cdp, mod ) {
	const url = baseUrl + "/test/index.html?module=" + encodeURIComponent( mod );
	await cdp.send( "Page.navigate", { url } );
	const start = Date.now();
	while ( Date.now() - start < MODULE_TIMEOUT ) {
		await sleep( 1000 );
		let out;
		try {
			out = await evaluate( cdp, COLLECT );
		} catch ( e ) {
			continue;
		}
		if ( out ) {
			return out;
		}
	}
	throw new Error( "Module " + mod + " timed out" );
}

// Tests excluded in headless Chrome by a source-level guard; each guard is
// preceded by a "SEAL-SKIP" comment naming the test and the reason.
function listSkipped() {
	const skipped = [];
	const unitDir = path.join( __dirname, "unit" );
	for ( const file of fs.readdirSync( unitDir ).sort() ) {
		const lines = fs.readFileSync( path.join( unitDir, file ), "utf8" ).split( "\n" );
		lines.forEach( ( l, i ) => {
			const m = /\/\/ SEAL-SKIP (.*)/.exec( l );
			if ( m ) {
				const cont = /^\s*\/\/ (?!SEAL-SKIP)(.*)/.exec( lines[ i + 1 ] || "" );
				skipped.push( file + ": SKIPPED " + m[ 1 ] + ( cont ? " " + cont[ 1 ] : "" ) );
			}
		} );
	}
	return skipped;
}

( async function main() {
	const { proc, wsUrl } = await launchChrome();
	const cdp = await connect( wsUrl );
	await cdp.send( "Page.enable" );
	await cdp.send( "Runtime.enable" );

	// A headless page never holds OS focus; emulate it so focus/blur tests behave
	// as in a foreground browser tab (as on TestSwarm)
	await cdp.send( "Emulation.setFocusEmulationEnabled", { enabled: true } );
	const ua = await evaluate( cdp, "navigator.userAgent" );
	console.log( "Browser: " + ua );

	let totalPass = 0, totalFail = 0;
	const failures = [];
	const summaries = [];
	for ( const mod of modules ) {
		console.log( "\n=== Module: " + mod + " ===" );
		let out;
		try {
			out = await runModule( cdp, mod );
		} catch ( e ) {
			console.log( "ERROR " + e.message );
			totalFail++;
			failures.push( mod + ": " + e.message );
			summaries.push( mod + ": TIMEOUT" );
			continue;
		}
		let p = 0, f = 0;
		for ( const t of out.tests ) {
			console.log( ( t.passed ? "PASS " : "FAIL " ) + t.module + " :: " + t.name + " " + t.counts );
			if ( t.passed ) {
				p++;
			} else {
				f++;
				failures.push( t.module + " :: " + t.name );
				for ( const a of t.failed ) {
					console.log( "    failed assertion: " + a.replace( /\s+/g, " " ) );
				}
			}
		}
		totalPass += p;
		totalFail += f;
		const line = mod + ": " + p + " passed, " + f + " failed (" + out.summary.replace( /\s+/g, " " ).trim() + ")";
		summaries.push( line );
		console.log( "Module summary: " + line );
	}
	cdp.close();
	proc.kill();

	console.log( "\n=== Summary per module ===" );
	summaries.forEach( ( s ) => console.log( s ) );
	if ( failures.length ) {
		console.log( "\nFailed tests:" );
		failures.forEach( ( s ) => console.log( "  " + s ) );
	}
	const skipped = listSkipped();
	console.log( "\nSkipped tests (" + skipped.length + "):" );
	skipped.forEach( ( s ) => console.log( "  " + s ) );
	console.log( "\nTOTAL: " + ( totalPass + totalFail ) + " tests, " + totalPass + " passed, " + totalFail + " failed" );
	process.exit( totalFail ? 1 : 0 );
} )().catch( ( e ) => {
	console.error( e );
	process.exit( 2 );
} );
