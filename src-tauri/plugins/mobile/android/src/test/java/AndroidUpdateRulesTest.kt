package app.taskrail.mobilebridge

import org.junit.Assert.*
import org.junit.Test

class AndroidUpdateRulesTest {
    @Test fun comparesStableVersionsNumerically() {
        assertTrue(AndroidUpdateRules.isNewer("v0.10.0", "0.9.9"))
        assertFalse(AndroidUpdateRules.isNewer("0.5.3", "0.5.3"))
        assertFalse(AndroidUpdateRules.isNewer("0.5.2", "0.5.3"))
        assertFalse(AndroidUpdateRules.isNewer("0.6.0-beta.1", "0.5.3"))
    }

    @Test fun skipsPrereleasesDraftsAndNonAndroidAssets() {
        val releases = """[
          {"tag_name":"v0.7.0","prerelease":true,"assets":[]},
          {"tag_name":"v0.8.0","draft":true,"assets":[]},
          {"tag_name":"v0.6.0","body":"Notes","assets":[
            {"name":"taskrail-x86_64.apk","browser_download_url":"https://github.com/Mowonhua/taskrail/releases/download/v0.6.0/x86.apk","size":20},
            {"name":"taskrail-arm64-v8a.apk","browser_download_url":"https://github.com/Mowonhua/taskrail/releases/download/v0.6.0/app.apk","size":42}]}
        ]"""
        val candidate = AndroidUpdateRules.selectRelease(releases, "0.5.3")!!
        assertEquals("0.6.0", candidate.version)
        assertEquals(42L, candidate.size)
        assertEquals("Notes", candidate.body)
        assertNull(AndroidUpdateRules.selectRelease(releases, "0.6.0"))
    }

    @Test fun rejectsAssetsOutsideTheReleaseRepository() {
        val releases = """[{"tag_name":"v0.6.0","assets":[
          {"name":"taskrail-arm64.apk","browser_download_url":"http://github.com/Mowonhua/taskrail/releases/download/v0.6.0/app.apk","size":42},
          {"name":"taskrail-arm64.apk","browser_download_url":"https://example.com/app.apk","size":42}]}]"""
        assertNull(AndroidUpdateRules.selectRelease(releases, "0.5.3"))
    }

    @Test fun choosesNewestInstallableReleaseRegardlessOfApiOrder() {
        val releases = """[
          {"tag_name":"v0.6.0","assets":[{"name":"taskrail-arm64.apk","browser_download_url":"https://github.com/Mowonhua/taskrail/releases/download/v0.6.0/app.apk","size":42}]},
          {"tag_name":"v0.8.0","assets":[]},
          {"tag_name":"v0.7.0","assets":[{"name":"taskrail-arm64.apk","browser_download_url":"https://github.com/Mowonhua/taskrail/releases/download/v0.7.0/app.apk","size":84}]}
        ]"""
        assertEquals("0.7.0", AndroidUpdateRules.selectRelease(releases, "0.5.3")!!.version)
        assertNull(AndroidUpdateRules.selectRelease(releases, "0.7.0"))
    }
}
