Loupe Flightdeck
----------------

NOTICE: please ask me for permission before using the code for any commercial purpose.

- Only tested on `Razer Stream Controller`_ (which is an identical device to `Loupedeck Live`_, I bought it because it's cheaper).

This project is now written in `TypeScript`_.

Install from NPM
----------------

::

   # macOS: make sure you have dependencies installed
   # brew install nodejs
   # brew install pkg-config pixman cairo pango

   npm install -g loupe-flightdeck # install this app
   loupe-flightdeck # run, or run with profile file name as first parameter
   # To specify X-Plane host and port:
   # loupe-flightdeck --xplane-host <host_ip> --xplane-port <port_number>

Try from the repo
-----------------
- Setup: ``npm install``
- Build: ``npm run build`` (compiles TypeScript to JavaScript in the `dist` folder)
- Run from source: ``npm run start`` (runs `app.ts` directly using `tsx`)
- Run compiled: ``node dist/app.js``
- To specify X-Plane host and port (for both `npm run start` and `node dist/app.js`):
  ``npm run start -- --xplane-host <host_ip> --xplane-port <port_number>``
  or
  ``node dist/app.js --xplane-host <host_ip> --xplane-port <port_number>``
  (Make sure you don't have other software using the same device, such as Loupedeck's official software running)

.. _Razer Stream Controller: https://www.amazon.com/Razer-Stream-Controller-All-One/dp/B0B5FV1BY6
.. _Loupedeck Live: https://loupedeck.com/us/products/loupedeck-live/
.. _TypeScript: https://www.typescriptlang.org/

Demo
----

.. raw:: html

    <div align="center">
    <img src="https://raw.githubusercontent.com/Determinant/loupedeck-ctrl/main/figures/main-page.jpg" width="70%">
    <img src="https://raw.githubusercontent.com/Determinant/loupedeck-ctrl/main/figures/ap-page.jpg" width="70%">
    </div>
 

Resources
---------

- Tested on Linux/Windows/macOS (different OS may require different ways to install the dependencies).
- Currently only X-Plane is supported. If you're interested in working on MSFS support, etc., please let me know.

- Videos: https://photos.app.goo.gl/1hAQ19DZQRo4RRr9A
- Profile is currently in ``profile.yaml``.
- Linux permission issue: copy ``50-loupedeck.rules`` to be under ``/etc/udev/rules.d`` and then ``sudo udevadm control --reload-rules && sudo udevadm trigger``. In Linux, install the font ``font.ttf`` to your system.