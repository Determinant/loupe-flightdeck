Loupe Flightdeck
----------------

NOTICE: please ask me for permission before using the code for any commercial purpose.

- Only tested on `Razer Stream Controller`_ (which is an identical device to `Loupedeck Live`_, I bought it because it's cheaper).
- Setup: ``npm install``
- Run: ``./app.mjs`` or ``node app.mjs`` (make sure you don't have other software using the same device, such as Loupedeck's official software running)

.. _Razer Stream Controller: https://www.amazon.com/Razer-Stream-Controller-All-One/dp/B0B5FV1BY6
.. _Loupedeck Live: https://loupedeck.com/us/products/loupedeck-live/

Demo
----

.. raw:: html

    <div align="center">
    <img src="https://raw.githubusercontent.com/Determinant/loupedeck-ctrl/main/figures/main-page.jpg" width="70%">
    <img src="https://raw.githubusercontent.com/Determinant/loupedeck-ctrl/main/figures/ap-page.jpg" width="70%">
    </div>
 

Resources
---------

- Only tested on Linux/Windows (run with CMD), please let me know if it also runs or doesn't run on macOS.
- Currently only X-Plane is supported. If you're interested in working on MSFS support, etc., please let me know.

- Videos: https://photos.app.goo.gl/1hAQ19DZQRo4RRr9A
- Profile is currently in ``profile.yaml``.
- Linux permission issue: copy ``50-loupedeck.rules`` to be under ``/etc/udev/rules.d`` and then ``sudo udevadm control --reload-rules && sudo udevadm trigger``. In Linux, install the font ``ocr-a-ext.ttf`` to your system.
